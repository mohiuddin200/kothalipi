"""Read aloud: turn text into speech with Kokoro and play it.

Kokoro is optional. Nothing here imports it until the first request, so a
service installed without it still starts and only read aloud is unavailable.
"""

import math
import os
import queue
import re
import shutil
import signal
import subprocess
import syslog
import threading
import time
import uuid

TTS_DIR_ENV = "KOTHALIPI_TTS_DIR"
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"
DEFAULT_VOICE = "af_heart"

# The first letter of a Kokoro voice name is its language.
VOICE_LANGUAGES = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "p": "pt-br",
}

SPEED_MIN = 0.5
SPEED_MAX = 2.0
MAX_TEXT_CHARS = 200000  # about three hours of speech
# Pieces grow as the reading goes on: the first is one short sentence so the
# first words come quickly, and each later one is made while the one before
# it plays.
CHUNK_CHARS = (80, 120, 200, 280)
SENTENCE_PAUSE_SECONDS = 0.3
LEVEL_HOP_SECONDS = 0.05
PLAYER_LATENCY_MS = 200
# Sound is heard about this long after the first samples reach the player.
PLAYER_START_SECONDS = 0.15
# A change of speed starts again from the clause being spoken. The place is
# estimated, so step back a little: a repeated word is better than a lost one.
RESUME_BACK_SECONDS = 0.4
RESUME_REPEAT_CHARS = 100  # a clause longer than this resumes at a word instead


class SpeechUnavailable(Exception):
    """Read aloud cannot run on this installation; the message says why."""


def tts_dir():
    """Where the installer puts the Kokoro model files."""
    override = os.environ.get(TTS_DIR_ENV)
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".local", "share", "kothalipi-service", "tts")


def player_command(sample_rate):
    """A command that plays raw mono float32 audio from its stdin, or None.

    Both players drain what they were given before they exit and go silent at
    once when killed, which ffmpeg's PulseAudio output does not.
    """
    if shutil.which("paplay"):
        return [
            "paplay",
            "--raw",
            "--format=float32le",
            f"--rate={sample_rate}",
            "--channels=1",
            f"--latency-msec={PLAYER_LATENCY_MS}",
            "--client-name=Kothalipi",
            "--stream-name=Read aloud",
        ]
    if shutil.which("pw-play"):
        return [
            "pw-play",
            "--raw",
            "--format=f32",
            f"--rate={sample_rate}",
            "--channels=1",
            "-",
        ]
    return None


def missing_parts():
    """What read aloud still needs, as short phrases. Empty when it can run."""
    missing = []
    try:
        from importlib.util import find_spec

        if find_spec("kokoro_onnx") is None:
            missing.append("the kokoro-onnx package")
    except Exception:
        missing.append("the kokoro-onnx package")
    directory = tts_dir()
    for name in (MODEL_FILE, VOICES_FILE):
        if not os.path.isfile(os.path.join(directory, name)):
            missing.append(f"the voice file {name}")
    if player_command(24000) is None:
        missing.append("an audio player (paplay or pw-play)")
    return missing


# ---------------------------------------------------------------- the text

_FENCE = re.compile(r"^\s*(```|~~~).*$", re.MULTILINE)
_MARKDOWN_LINK = re.compile(r"!?\[([^\]]*)\]\([^)\s]*\)")
_URL = re.compile(r"(?:https?://|www\.)\S+")
_TAG = re.compile(r"</?[a-zA-Z][^<>]{0,200}>")
_RULE = re.compile(r"^\s*([-=_*~#])\1{2,}\s*$")
_HEADING = re.compile(r"^\s*#{1,6}\s+")
_QUOTE = re.compile(r"^\s*(>\s*)+")
_BULLET = re.compile(r"^\s*[-*+•◦▪]\s+")
_NUMBERED = re.compile(r"^\s*\d{1,3}[.)]\s+")
_TABLE_RULE = re.compile(r"^:?-+:?$")
_SENTENCE_END = re.compile(r"[.!?…:;,][\"')\]”’]*$")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])[\"')\]”’]*\s+")
_CLAUSE_SPLIT = re.compile(r"(?<=[,;:])\s+")
_RESUME_POINT = re.compile(r"(?<=[.!?\u2026,;:])[\"')\]\u201d\u2019]*\s+")


def _clean_line(line):
    line = _MARKDOWN_LINK.sub(r"\1", line)
    line = _URL.sub(" link ", line)
    line = _TAG.sub(" ", line)
    # Emphasis and code marks, and the underscores of identifiers.
    line = re.sub(r"[`*~]+", "", line).replace("_", " ")
    if "|" in line:
        # A table row: its cells are read as a list, its ruler is skipped.
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        line = ", ".join(cell for cell in cells if cell and not _TABLE_RULE.match(cell))
    line = " ".join(line.split())
    return re.sub(r"\s+([,.;:!?])", r"\1", line)


def clean_text(text):
    """Make selected text speakable.

    Selections come from web pages, terminals and Markdown, so lines are often
    wrapped by hand and carry markup. Wrapped lines are joined into sentences;
    headings, list items and paragraphs each end with a pause.
    """
    text = (text or "")[:MAX_TEXT_CHARS].replace("\r\n", "\n").replace("\r", "\n")
    text = _FENCE.sub("", text)

    blocks = []
    current = []

    def flush():
        if current:
            blocks.append(" ".join(current))
            del current[:]

    for raw in text.split("\n"):
        if not raw.strip() or _RULE.match(raw):
            flush()
            continue
        line = _QUOTE.sub("", raw)
        heading = bool(_HEADING.match(line))
        starts_block = (
            heading
            or line.lstrip().startswith("|")
            or bool(_BULLET.match(line) or _NUMBERED.match(line))
        )
        line = _BULLET.sub("", _HEADING.sub("", line))
        line = _clean_line(line)
        if not line:
            continue
        if starts_block:
            flush()
        if current and current[-1].endswith("-") and len(current[-1]) > 1:
            # A word broken across two lines.
            current[-1] = current[-1][:-1] + line
        else:
            current.append(line)
        if heading:
            flush()
    flush()

    sentences = []
    for block in blocks:
        if not re.search(r"\w", block):
            continue
        if not _SENTENCE_END.search(block):
            block += "."
        sentences.append(block)
    return " ".join(sentences)


def _split_long(piece, limit):
    """Cut `piece` into parts no longer than `limit`, at clauses then words."""
    if len(piece) <= limit:
        return [piece]
    parts = []
    current = ""
    for clause in _CLAUSE_SPLIT.split(piece):
        words = [clause]
        if len(clause) > limit:
            words = clause.split(" ")
        for word in words:
            candidate = f"{current} {word}" if current else word
            if len(candidate) > limit and current:
                parts.append(current)
                current = word
            else:
                current = candidate
    if current:
        parts.append(current)
    return parts


def split_chunks(text):
    """Cut cleaned text into the pieces that are synthesized one at a time."""
    chunks = []
    current = ""

    def limit():
        return CHUNK_CHARS[min(len(chunks), len(CHUNK_CHARS) - 1)]

    for sentence in _SENTENCE_SPLIT.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        for part in _split_long(sentence, limit()):
            candidate = f"{current} {part}" if current else part
            # The first piece is never more than one sentence.
            if current and (not chunks or len(candidate) > limit()):
                chunks.append(current)
                current = part
            else:
                current = candidate
    if current:
        chunks.append(current)
    return chunks


def text_from(chunk, played, seconds):
    """What is left of `chunk` after `played` of its `seconds` have been heard.

    Starts at the clause being spoken, so the listener loses nothing.
    """
    if seconds <= 0 or played >= seconds:
        return ""
    position = int(len(chunk) * max(0.0, played - RESUME_BACK_SECONDS) / seconds)
    start = 0
    for match in _RESUME_POINT.finditer(chunk):
        if match.end() > position:
            break
        start = match.end()
    if position - start > RESUME_REPEAT_CHARS:
        space = chunk.rfind(" ", start, position)
        if space > start:
            start = space + 1
    return chunk[start:]


# ------------------------------------------------------------- the speaker


def _clamp_speed(speed):
    try:
        speed = float(speed)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(speed):
        return 1.0
    return max(SPEED_MIN, min(SPEED_MAX, speed))


class _Job:
    def __init__(self, speech_id, text, voice, speed, chunks=None):
        self.id = speech_id
        self.text = text
        self.voice = voice
        self.speed = speed
        # The pieces to speak; cut from `text` when the job starts.
        self.chunks = chunks
        self.stop = threading.Event()
        self.player = None
        self.lock = threading.Lock()
        # (time the piece starts playing, its level every LEVEL_HOP_SECONDS,
        #  its place in `chunks`, how long its speech lasts)
        self.pieces = []
        self.play_end = 0.0
        # Silence the listener heard because a piece was not ready in time.
        self.gap_seconds = 0.0
        self.failure = None
        self.completed = False  # everything was played to the end
        self.done = False
        # Another job carries on with this speech, so this one ends silently.
        self.superseded = False
        # When the listener paused, or None while playing.
        self.paused_at = None
        # A speed chosen while paused; it takes effect when the reading resumes.
        self.pending_speed = None


class Speaker:
    """Speaks one text at a time. Callbacks arrive on worker threads.

    on_started(speech_id)            the first sound is playing
    on_finished(speech_id, reason)   "completed" or "stopped"
    on_error(speech_id, message)
    on_level(speech_id, level)       loudness of what is playing, 0..1

    Pausing holds the player process still (SIGSTOP), so resuming carries on
    from the very sample it stopped at.
    """

    def __init__(self, on_started, on_finished, on_error, on_level):
        self._on_started = on_started
        self._on_finished = on_finished
        self._on_error = on_error
        self._on_level = on_level
        self._kokoro = None
        # One synthesis at a time; a stopped job may still be finishing a piece.
        self._synth_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._job = None

    def speak(self, text, voice, speed):
        """Start speaking `text` and return an id for it. Replaces any speech in progress."""
        speech_id = str(uuid.uuid4())
        job = _Job(
            speech_id, text, (voice or "").strip() or DEFAULT_VOICE, _clamp_speed(speed)
        )
        with self._state_lock:
            previous = self._job
            self._job = job
        if previous is not None:
            self._halt(previous)
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return speech_id

    def stop(self, speech_id=""):
        """Stop the speech in progress. An id that is not the current one is ignored."""
        job = self._current(speech_id)
        if job is None:
            return False
        self._halt(job)
        return True

    def _current(self, speech_id):
        """The job in progress, or None when there is none or the id is another's."""
        job = self._job
        if job is None or job.done or (speech_id and speech_id != job.id):
            return None
        return job

    def pause(self, speech_id=""):
        """Hold the speech in progress where it is."""
        job = self._current(speech_id)
        if job is None:
            return False
        with job.lock:
            if job.paused_at is None:
                job.paused_at = time.monotonic()
                self._signal_player(job, signal.SIGSTOP)
        return True

    def resume(self, speech_id=""):
        """Carry on with a paused speech."""
        job = self._current(speech_id)
        if job is None:
            return False
        with job.lock:
            if job.paused_at is None:
                return True
            # What is left plays this much later than it was going to.
            shift = time.monotonic() - job.paused_at
            job.paused_at = None
            job.pieces = [(start + shift, *rest) for start, *rest in job.pieces]
            job.play_end += shift
            speed = job.pending_speed
            job.pending_speed = None
            if speed is None or abs(speed - job.speed) < 0.001:
                self._signal_player(job, signal.SIGCONT)
                return True
        # The speed was changed while paused: carry on at the new one.
        return self.set_speed(job.id, speed)

    @staticmethod
    def _signal_player(job, signum):
        player = job.player
        if player is not None and player.poll() is None:
            try:
                player.send_signal(signum)
            except Exception:
                pass

    def set_speed(self, speech_id, speed):
        """Carry on with the speech in progress at another speed.

        Speed is part of how a piece is synthesized, so what is left is made
        again, from the clause being spoken. The speech keeps its id.
        """
        speed = _clamp_speed(speed)
        with self._state_lock:
            job = self._current(speech_id)
            if job is None:
                return False
            if job.chunks is None:
                # Nothing has been synthesized yet; the job reads its speed then.
                job.speed = speed
                return True
            with job.lock:
                if job.paused_at is not None:
                    job.pending_speed = speed
                    return True
            if abs(speed - job.speed) < 0.001:
                return True
            remaining = self._remaining(job)
            if not remaining:
                return True  # the last words are already playing
            successor = _Job(job.id, "", job.voice, speed, chunks=remaining)
            job.superseded = True
            self._job = successor
        self._halt(job)
        threading.Thread(target=self._run, args=(successor,), daemon=True).start()
        return True

    @staticmethod
    def _remaining(job):
        """The pieces of `job` that have not been heard yet."""
        chunks = job.chunks
        now = time.monotonic()
        with job.lock:
            pieces = list(job.pieces)
        if not pieces or now < pieces[0][0]:
            # Nothing has been heard yet.
            return list(chunks[pieces[0][2] if pieces else 0 :])
        for start, _levels, index, seconds in reversed(pieces):
            if now >= start:
                break
        rest = [text_from(chunks[index], now - start, seconds)] + list(chunks[index + 1 :])
        # Cut again, so the first piece is short and the voice is back quickly.
        return split_chunks(" ".join(part for part in rest if part))

    def shutdown(self):
        job = self._job
        if job is not None:
            self._halt(job)

    @staticmethod
    def _halt(job):
        job.stop.set()
        with job.lock:
            player = job.player
        if player is not None and player.poll() is None:
            try:
                player.kill()
            except Exception:
                pass

    def _load(self):
        if self._kokoro is None:
            missing = missing_parts()
            if missing:
                raise SpeechUnavailable(
                    "Read aloud is not installed: missing " + ", ".join(missing)
                )
            from kokoro_onnx import Kokoro

            started = time.time()
            directory = tts_dir()
            self._kokoro = Kokoro(
                os.path.join(directory, MODEL_FILE), os.path.join(directory, VOICES_FILE)
            )
            syslog.syslog(
                syslog.LOG_INFO, f"Kokoro voice model loaded in {time.time() - started:.1f}s"
            )
        return self._kokoro

    def _run(self, job):
        """Make the pieces of one job; a second thread plays them as they come.

        Making runs one piece ahead of playing, so the voice does not pause
        between pieces.
        """
        ready = queue.Queue(maxsize=1)
        feeder = threading.Thread(target=self._feed, args=(job, ready), daemon=True)
        feeder.start()
        try:
            self._synthesize(job, ready)
        except Exception as e:
            if not job.stop.is_set():
                job.failure = e
            self._halt(job)
        feeder.join()

        job.done = True
        self._halt(job)
        if job.player is not None:
            try:
                job.player.wait(timeout=2)
            except Exception:
                pass
        if job.superseded:
            return
        if job.failure is not None:
            message = str(job.failure)
            if isinstance(job.failure, BrokenPipeError):
                message = "The audio player stopped before the speech was played"
            syslog.syslog(syslog.LOG_ERR, f"Read aloud failed: {message}")
            self._on_error(job.id, message)
            return
        reason = "completed" if job.completed else "stopped"
        syslog.syslog(
            syslog.LOG_INFO, f"Read aloud {reason} (waited {job.gap_seconds:.1f}s for pieces)"
        )
        self._on_finished(job.id, reason)

    def _synthesize(self, job, ready):
        chunks = job.chunks
        if chunks is None:
            chunks = split_chunks(clean_text(job.text))
            job.chunks = chunks
        if not chunks:
            raise ValueError("There is no readable text in the selection")
        syslog.syslog(
            syslog.LOG_INFO,
            f"Reading aloud: {sum(len(chunk) for chunk in chunks)} characters in "
            f"{len(chunks)} pieces (voice={job.voice}, speed={job.speed})",
        )

        import numpy as np

        made = 0
        for index, chunk in enumerate(chunks):
            with self._synth_lock:
                if job.stop.is_set():
                    return
                kokoro = self._load()
                voice = job.voice if job.voice in kokoro.get_voices() else DEFAULT_VOICE
                try:
                    audio, sample_rate = kokoro.create(
                        chunk,
                        voice=voice,
                        speed=job.speed,
                        lang=VOICE_LANGUAGES.get(voice[:1], "en-us"),
                    )
                except ValueError as e:
                    # A piece with nothing the voice can say, such as a line
                    # of symbols. The rest is still worth reading.
                    syslog.syslog(syslog.LOG_INFO, f"Skipped a piece that cannot be spoken: {e}")
                    continue
            audio = np.asarray(audio, dtype=np.float32).ravel()
            if len(audio) == 0:
                continue
            seconds = len(audio) / float(sample_rate)
            if index < len(chunks) - 1:
                pause = np.zeros(int(SENTENCE_PAUSE_SECONDS * sample_rate), dtype=np.float32)
                audio = np.concatenate([audio, pause])
            if not self._hand_over(job, ready, (audio, sample_rate, index, seconds)):
                return
            made += 1

        if not made:
            raise ValueError("There is no readable text in the selection")
        self._hand_over(job, ready, None)

    @staticmethod
    def _hand_over(job, ready, piece):
        """Queue a piece for playing, or None after the last. False when the job was stopped."""
        while not job.stop.is_set():
            try:
                ready.put(piece, timeout=0.1)
                return True
            except queue.Full:
                continue
        return False

    def _feed(self, job, ready):
        """Play the pieces as they are made, then wait for the last to be heard."""
        try:
            while not job.stop.is_set():
                try:
                    piece = ready.get(timeout=0.1)
                except queue.Empty:
                    continue
                if piece is None:
                    job.player.stdin.close()
                    while job.player.poll() is None:
                        if job.stop.wait(0.05):
                            return
                    job.completed = True
                    return
                audio, sample_rate, index, seconds = piece
                if job.player is None:
                    self._start_player(job, sample_rate)
                self._play(job, audio, sample_rate, index, seconds)
        except Exception as e:
            # A player killed under a write is how a stop looks.
            if not job.stop.is_set():
                job.failure = e
            self._halt(job)

    def _start_player(self, job, sample_rate):
        command = player_command(sample_rate)
        if command is None:
            raise SpeechUnavailable(
                "Read aloud is not installed: missing an audio player (paplay or pw-play)"
            )
        player = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        with job.lock:
            job.player = player
            if job.paused_at is not None:
                # Paused before the first words were ready.
                self._signal_player(job, signal.SIGSTOP)
        if job.stop.is_set():
            self._halt(job)
            return
        self._on_started(job.id)
        threading.Thread(target=self._report_levels, args=(job,), daemon=True).start()

    def _play(self, job, audio, sample_rate, index, seconds):
        """Hand one piece to the player. Blocks while the player is ahead.

        `index` is the piece's place in the job's chunks, `seconds` how long
        its speech lasts without the pause that follows it.
        """
        import numpy as np

        hop = max(1, int(sample_rate * LEVEL_HOP_SECONDS))
        count = len(audio) // hop
        frames = audio[: count * hop].reshape(count, hop) if count else audio.reshape(1, -1)
        rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
        # The same -50..-12 dBFS window the recording level uses.
        decibels = 20.0 * np.log10(np.maximum(rms, 1e-6))
        levels = np.clip((decibels + 50.0) / 38.0, 0.0, 1.0).tolist()

        with job.lock:
            # A piece plays when the one before it ends, or now if the player ran dry.
            start = max(job.play_end, time.monotonic() + PLAYER_START_SECONDS)
            if job.pieces:
                job.gap_seconds += start - job.play_end
            job.pieces.append((start, levels, index, seconds))
            job.play_end = start + len(audio) / float(sample_rate)

        job.player.stdin.write(audio.tobytes())
        job.player.stdin.flush()

    def _report_levels(self, job):
        """Send the loudness of what is being heard, for the pill's bars."""
        while not job.done and not job.stop.is_set():
            now = time.monotonic()
            level = 0.0
            with job.lock:
                paused = job.paused_at is not None
                for start, levels, _index, _seconds in reversed(job.pieces):
                    if now >= start:
                        index = int((now - start) / LEVEL_HOP_SECONDS)
                        if index < len(levels):
                            level = levels[index]
                        break
            if not paused:
                try:
                    self._on_level(job.id, level)
                except Exception:
                    return
            time.sleep(LEVEL_HOP_SECONDS)
