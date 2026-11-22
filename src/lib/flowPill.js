import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Pango from "gi://Pango";
import St from "gi://St";
import Cairo from "cairo";
import * as Config from "resource:///org/gnome/shell/misc/config.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

// The floating dictation pill. One Cairo canvas draws every state so the
// shape can morph continuously; a separate reactive actor follows the pill
// body and is the only part that takes pointer input.

// Before GNOME 50 (X11 sessions) chrome had to declare its input region.
// Wayland-only shells route input by actor reactivity and reject the option.
const NEEDS_INPUT_REGION = parseInt(Config.PACKAGE_VERSION, 10) < 50;

const CANVAS_W = 380;
const CANVAS_H = 260;
const BASE_LIFT = 14; // gap between the pill and the screen edge
const DOCK_GAP = 10; // gap between the pill and a visible bottom dock
const HIT_PAD = 6;

const BAR_COUNT = 13;
const BAR_WIDTH = 3;
const BAR_PITCH = 6;
const BAR_MAX = 22;
const BUTTON_RADIUS = 13;
const BUTTON_INSET = 20; // button centre from the pill's end
const BUTTON_PITCH = 30; // between two buttons that sit side by side
const SPEAKING_BARS_SHIFT = -1; // the bars sit between two pairs of buttons

const INK = [0.063, 0.063, 0.071];
const STOP_RED = [0.898, 0.282, 0.302];
const AMBER = [1.0, 0.698, 0.141];

// Geometry and material per visual state.
const SPEC = {
  hidden: { w: 40, h: 10, fill: 0, border: 0, elev: 0 },
  rest: { w: 40, h: 10, fill: 0.72, border: 0.22, elev: 0.3 },
  hover: { w: 104, h: 30, fill: 0.94, border: 0.16, elev: 0.8 },
  recording: { w: 176, h: 40, fill: 0.96, border: 0.14, elev: 1 },
  speaking: { w: 226, h: 40, fill: 0.96, border: 0.14, elev: 1 },
  processing: { w: 112, h: 34, fill: 0.96, border: 0.14, elev: 0.9 },
  done: { w: 52, h: 34, fill: 0.96, border: 0.14, elev: 0.9 },
  error: { w: 52, h: 34, fill: 0.96, border: 0.14, elev: 0.9 },
};

const STIFF_ENTER = 420; // settles in about 280 ms
const STIFF_EXIT = 760; // exits read faster than entrances
const STIFF_FEEDBACK = 1600; // hover and press, about 150 ms

const LABEL_STYLE = `
  background-color: rgba(16, 16, 18, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 13px;
  padding: 5px 12px;
  max-width: 330px;
  color: rgba(255, 255, 255, 0.94);
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
`;

// Critically damped spring, solved exactly so any frame time is stable and a
// retarget mid-flight keeps its velocity.
class Spring {
  constructor(value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.stiffness = STIFF_ENTER;
  }

  to(target, stiffness) {
    this.target = target;
    if (stiffness) this.stiffness = stiffness;
  }

  snap() {
    this.value = this.target;
    this.velocity = 0;
  }

  get settled() {
    return this.value === this.target && this.velocity === 0;
  }

  step(dt) {
    if (this.settled) return;
    const w = Math.sqrt(this.stiffness);
    const x = this.value - this.target;
    const c = this.velocity + w * x;
    const e = Math.exp(-w * dt);
    this.value = this.target + (x + c * dt) * e;
    this.velocity = (this.velocity - w * c * dt) * e;
    if (
      Math.abs(this.value - this.target) < 0.005 &&
      Math.abs(this.velocity) < 0.05
    )
      this.snap();
  }
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function roundedRect(cr, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  cr.newSubPath();
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  cr.closePath();
}

export class FlowPill {
  /**
   * @param {object} actions
   * @param {Function} actions.onStart - click on the idle pill
   * @param {Function} actions.onStop - stop button, or click on the body while recording
   * @param {Function} actions.onCancel - cancel button
   * @param {Function} actions.onStopSpeaking - stop button while reading aloud
   * @param {Function} actions.onPauseToggle - pause or play button, or click on the body while reading aloud
   * @param {Function} actions.onSlower - slower button while reading aloud
   * @param {Function} actions.onFaster - faster button while reading aloud
   * @param {Function} actions.onSecondary - right click on the idle pill
   */
  constructor(actions) {
    this._actions = actions;
    this._state = "idle";
    this._stateAge = 0;
    this._clock = 0;
    this._idleVisible = true;
    this._suppressed = false; // overview or fullscreen
    this._hovered = false;
    this._paused = false; // reading aloud is on hold
    this._zone = null;
    this._pressedZone = null;
    this._shortcutLabel = "";
    this._barsMoving = false;
    this._labelMarkup = null;
    this._labelTimeoutId = 0;
    this._settleTimeoutId = 0;
    this._hoverTimeoutId = 0;
    this._lastFrameUs = 0;

    this._level = 0;
    this._levelTarget = 0;
    this._lastLevelAt = -1;
    this._levelHistory = new Float32Array(64);
    this._levelHead = 0;

    this._springs = {
      w: new Spring(SPEC.rest.w),
      h: new Spring(SPEC.rest.h),
      fill: new Spring(0),
      border: new Spring(0),
      elev: new Spring(0),
      lift: new Spring(BASE_LIFT),
      bars: new Spring(0),
      barsShift: new Spring(0),
      cancel: new Spring(0),
      stop: new Spring(0),
      controls: new Spring(0),
      paused: new Spring(0),
      cancelHover: new Spring(0),
      stopHover: new Spring(0),
      pauseHover: new Spring(0),
      slowerHover: new Spring(0),
      fasterHover: new Spring(0),
      press: new Spring(0),
      check: new Spring(0),
      glyph: new Spring(0),
    };

    this._bars = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      this._bars.push({
        height: BAR_WIDTH,
        alpha: 1,
        rate: 5 + Math.random() * 6,
        phase: Math.random() * Math.PI * 2,
      });
    }

    this._buildActors();
    this._connectShell();
    this._relayout();
    this._applyTargets();
    for (const spring of Object.values(this._springs)) spring.snap();
    this._syncActors();
    this._canvas.queue_repaint();
  }

  // ---------------------------------------------------------------- public

  get state() {
    return this._state;
  }

  /** @param {"idle"|"recording"|"speaking"|"processing"|"done"|"error"} state */
  setState(state, { label = null, holdMs = 0 } = {}) {
    if (!SPEC[state] && state !== "idle") return;
    const previous = this._state;
    this._state = state;
    this._stateAge = 0;
    this._pressedZone = null;
    this._paused = false;
    this._springs.paused.to(0, STIFF_FEEDBACK);
    this._clearTimeout("_settleTimeoutId");

    if ((state === "recording" || state === "speaking") && previous !== state) {
      this._level = 0;
      this._levelTarget = 0;
      this._lastLevelAt = -1;
      this._levelHistory.fill(0);
    }

    if (state === "done" || state === "error") {
      this._settleTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        holdMs || (state === "done" ? 1500 : 4200),
        () => {
          this._settleTimeoutId = 0;
          if (this._state === state) this.setState("idle");
          return GLib.SOURCE_REMOVE;
        }
      );
    }

    this._refreshDock();
    this._applyTargets();
    this._updateZone();
    // Only a growing recording hint is cut at its start; see setHint.
    this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    this._showLabel(label);
    this._wake();
  }

  /** Level of the voice being recorded or read aloud, from the service, 0..1. */
  pushLevel(level) {
    this._levelTarget = clamp01(level);
    this._lastLevelAt = this._clock;
  }

  /**
   * A short line shown above the pill while recording or reading aloud, or
   * null to clear it. `keepEnd` cuts a line that is too long at its start,
   * for text that grows. With `holdMs` the line goes away by itself.
   */
  setHint(markup, { keepEnd = false, holdMs = 0 } = {}) {
    if (this._state !== "recording" && this._state !== "speaking") return;
    this._label.clutter_text.ellipsize = keepEnd
      ? Pango.EllipsizeMode.START
      : Pango.EllipsizeMode.END;
    this._showLabel(markup, holdMs);
  }

  /** While reading aloud: show the reading as on hold, with a play button. */
  setPaused(paused) {
    if (this._state !== "speaking") return;
    this._paused = paused;
    this._springs.paused.to(paused ? 1 : 0, STIFF_FEEDBACK);
    this._wake();
  }

  setShortcutLabel(text) {
    this._shortcutLabel = text || "";
  }

  setIdleVisible(visible) {
    this._idleVisible = visible;
    this._applyTargets();
    this._wake();
  }

  destroy() {
    this._clearTimeout("_labelTimeoutId");
    this._clearTimeout("_settleTimeoutId");
    this._clearTimeout("_hoverTimeoutId");
    this._disconnectShell();
    if (this._timeline) {
      this._timeline.stop();
      this._timeline = null;
    }
    if (this._stage) {
      if (NEEDS_INPUT_REGION) Main.layoutManager.untrackChrome(this._hit);
      Main.layoutManager.removeChrome(this._stage);
      this._stage.destroy();
      this._stage = null;
    }
  }

  // ------------------------------------------------------------ construction

  _buildActors() {
    this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

    this._stage = new St.Widget({
      reactive: false,
      layout_manager: new Clutter.FixedLayout(),
    });

    this._canvas = new St.DrawingArea({ reactive: false });
    this._canvas.connect("repaint", (area) => this._paint(area));
    this._stage.add_child(this._canvas);

    this._label = new St.Label({
      style: LABEL_STYLE,
      opacity: 0,
      reactive: false,
    });
    this._label.clutter_text.use_markup = true;
    this._stage.add_child(this._label);

    this._hit = new St.Widget({ reactive: true, track_hover: true });
    this._hit.connect("notify::hover", () => this._onHoverChanged());
    this._hit.connect("motion-event", (_a, event) => {
      this._updateZone(event);
      return Clutter.EVENT_PROPAGATE;
    });
    this._hit.connect("button-press-event", (_a, event) =>
      this._onPress(event)
    );
    this._hit.connect("button-release-event", (_a, event) =>
      this._onRelease(event)
    );
    this._hit.connect("touch-event", (_a, event) => this._onTouch(event));
    this._stage.add_child(this._hit);

    if (NEEDS_INPUT_REGION) {
      Main.layoutManager.addChrome(this._stage, { affectsInputRegion: false });
      Main.layoutManager.trackChrome(this._hit, { affectsInputRegion: true });
    } else {
      Main.layoutManager.addChrome(this._stage);
    }

    this._timeline = new Clutter.Timeline({
      actor: this._canvas,
      duration: 1000,
      repeat_count: -1,
    });
    this._timeline.connect("new-frame", () => this._onFrame());
  }

  _connectShell() {
    this._shellSignals = [
      [
        Main.layoutManager,
        Main.layoutManager.connect("monitors-changed", () => this._relayout()),
      ],
      // The dock extension may load after this one, or rebuild its dock.
      [
        Main.uiGroup,
        Main.uiGroup.connect("child-added", () => this._refreshDock()),
      ],
      [
        Main.uiGroup,
        Main.uiGroup.connect("child-removed", () => this._refreshDock()),
      ],
      [
        Main.overview,
        Main.overview.connect("showing", () => this._setSuppressed()),
      ],
      [
        Main.overview,
        Main.overview.connect("hidden", () => this._setSuppressed()),
      ],
      [
        global.display,
        global.display.connect("in-fullscreen-changed", () =>
          this._setSuppressed()
        ),
      ],
    ];
    this._setSuppressed();
  }

  _disconnectShell() {
    for (const [object, id] of this._shellSignals ?? []) object.disconnect(id);
    this._shellSignals = [];
    this._releaseDock();
  }

  _relayout() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || !this._stage) return;
    const s = this._scale;
    this._stage.set_size(CANVAS_W * s, CANVAS_H * s);
    this._stage.set_position(
      monitor.x + Math.floor((monitor.width - CANVAS_W * s) / 2),
      monitor.y + monitor.height - CANVAS_H * s
    );
    this._canvas.set_size(CANVAS_W * s, CANVAS_H * s);
    this._refreshDock();
    this._setSuppressed();
  }

  _setSuppressed() {
    const monitor = Main.layoutManager.primaryMonitor;
    this._suppressed = Main.overview.visible || !!monitor?.inFullscreen;
    this._applyTargets();
    this._wake();
  }

  // ------------------------------------------------------------------ dock

  // Ubuntu Dock / Dash to Dock slides in over the bottom edge. When one sits
  // on our monitor the pill rides above it instead of covering its icons.
  _refreshDock() {
    let dock = null;
    try {
      const monitorIndex = Main.layoutManager.primaryIndex;
      dock =
        Main.uiGroup
          .get_children()
          .find(
            (actor) =>
              actor.name === "dashtodockContainer" &&
              actor.position === St.Side.BOTTOM &&
              actor.monitorIndex === monitorIndex
          ) ?? null;
    } catch (_e) {
      dock = null;
    }

    if (dock !== this._dock) {
      this._releaseDock();
      this._dock = dock;
      if (dock) {
        this._dockSignals = [
          dock.connect("showing", () => this._setDockShown(true)),
          dock.connect("hiding", () => this._setDockShown(false)),
          dock.connect("destroy", () => {
            this._dock = null;
            this._dockSignals = [];
            this._setDockShown(false);
          }),
        ];
      }
    }

    let shown = false;
    try {
      const state = dock?.getDockState?.();
      shown = state === 1 || state === 2; // SHOWING or SHOWN
    } catch (_e) {
      shown = false;
    }
    this._setDockShown(shown);
  }

  _releaseDock() {
    if (this._dock) {
      for (const id of this._dockSignals ?? []) {
        try {
          this._dock.disconnect(id);
        } catch (_e) {
          // The dock went away first.
        }
      }
    }
    this._dock = null;
    this._dockSignals = [];
  }

  _setDockShown(shown) {
    let lift = BASE_LIFT;
    if (shown && this._dock) {
      const height = this._dock._box?.height ?? this._dock.height ?? 0;
      lift = Math.min(height / this._scale + DOCK_GAP, CANVAS_H - 96);
    }
    this._springs.lift.to(Math.max(BASE_LIFT, lift), STIFF_ENTER);
    this._wake();
  }

  // ---------------------------------------------------------------- targets

  _visualState() {
    if (this._state !== "idle") return this._state;
    if (!this._idleVisible || this._suppressed) return "hidden";
    return this._hovered ? "hover" : "rest";
  }

  _applyTargets() {
    const visual = this._visualState();
    const spec = SPEC[visual];
    const sp = this._springs;
    const growing = spec.w >= sp.w.target;
    const stiffness = growing ? STIFF_ENTER : STIFF_EXIT;

    sp.w.to(spec.w, stiffness);
    sp.h.to(spec.h, stiffness);
    sp.fill.to(spec.fill, stiffness);
    sp.border.to(spec.border, stiffness);
    sp.elev.to(spec.elev, stiffness);

    const barsOn =
      visual === "hover" ||
      visual === "recording" ||
      visual === "speaking" ||
      visual === "processing";
    sp.bars.to(barsOn ? 1 : 0, barsOn ? STIFF_ENTER : STIFF_EXIT);
    sp.barsShift.to(visual === "speaking" ? SPEAKING_BARS_SHIFT : 0, stiffness);

    if (visual !== "recording") sp.cancel.to(0, STIFF_EXIT);
    if (visual !== "speaking") sp.controls.to(0, STIFF_EXIT);
    if (visual !== "recording" && visual !== "speaking")
      sp.stop.to(0, STIFF_EXIT);
    sp.check.to(visual === "done" ? 1 : 0, visual === "done" ? 300 : STIFF_EXIT);
    sp.glyph.to(visual === "error" ? 1 : 0, STIFF_ENTER);

    if (!this._animationsEnabled()) {
      for (const spring of Object.values(sp)) spring.snap();
    }
  }

  // Targets that depend on how long the state has been showing: the buttons
  // arrive one after the other once the pill has started to open.
  _applyTimedTargets() {
    const recording = this._state === "recording";
    if (!recording && this._state !== "speaking") return;
    const sp = this._springs;
    if (this._stateAge > 0.07) (recording ? sp.cancel : sp.controls).to(1, STIFF_ENTER);
    if (this._stateAge > 0.12) sp.stop.to(1, STIFF_ENTER);
    if (!this._animationsEnabled()) {
      sp.cancel.snap();
      sp.controls.snap();
      sp.stop.snap();
    }
  }

  _animationsEnabled() {
    return St.Settings.get().enable_animations;
  }

  // ------------------------------------------------------------------ frame

  _wake() {
    if (!this._timeline) return;
    if (!this._timeline.is_playing()) {
      this._lastFrameUs = GLib.get_monotonic_time();
      this._timeline.start();
    }
  }

  _needsFrames() {
    if (
      this._state === "recording" ||
      (this._state === "speaking" && !this._paused) ||
      this._state === "processing"
    )
      return true;
    if (this._barsMoving) return true;
    return !Object.values(this._springs).every((spring) => spring.settled);
  }

  _onFrame() {
    const now = GLib.get_monotonic_time();
    const dt = Math.min(0.05, Math.max(0.001, (now - this._lastFrameUs) / 1e6));
    this._lastFrameUs = now;
    this._clock += dt;
    this._stateAge += dt;

    this._applyTimedTargets();
    for (const spring of Object.values(this._springs)) spring.step(dt);
    this._stepBars(dt);
    this._syncActors();
    this._canvas.queue_repaint();

    if (!this._needsFrames()) this._timeline.stop();
  }

  _stepBars(dt) {
    const recording = this._state === "recording";
    const speaking = this._state === "speaking" && !this._paused;
    // Reading aloud is quiet until the service has made the first words.
    const waiting = speaking && this._lastLevelAt < 0;
    const voiced = recording || (speaking && !waiting);
    const processing = this._state === "processing" || waiting;

    // Fast attack, slower release: bars jump with the voice and fall softly.
    let target = voiced ? this._levelTarget : 0;
    if (recording && this._lastLevelAt < 0 && this._stateAge > 0.7) {
      // The service sends no levels (older version): breathe instead of
      // pretending to follow the voice.
      target = 0.2 + 0.1 * Math.sin(this._clock * 3.6);
    } else if (voiced && this._clock - this._lastLevelAt > 0.4) {
      target = 0;
    }
    const tau = target > this._level ? 0.03 : 0.16;
    this._level += (target - this._level) * (1 - Math.exp(-dt / tau));

    this._levelHead = (this._levelHead + 1) % this._levelHistory.length;
    this._levelHistory[this._levelHead] = this._level;

    const centre = (BAR_COUNT - 1) / 2;
    const sweep = ((this._clock % 1.25) / 1.25) * (BAR_COUNT + 6) - 3;
    const animate = this._animationsEnabled();
    let moving = false;

    this._bars.forEach((bar, i) => {
      let height = BAR_WIDTH;
      let alpha = 0.72;

      if (voiced) {
        // The centre shows the newest level; it ripples outwards.
        const distance = Math.abs(i - centre);
        const delayFrames = Math.round(distance * 1.7);
        const index =
          (this._levelHead - delayFrames + this._levelHistory.length) %
          this._levelHistory.length;
        const level = this._levelHistory[index];
        const envelope = 0.42 + 0.58 * Math.cos((distance / (centre + 1.4)) * (Math.PI / 2)) ** 2;
        const flutter = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(this._clock * bar.rate + bar.phase));
        height = BAR_WIDTH + (BAR_MAX - BAR_WIDTH) * clamp01(level * envelope * flutter * 1.25);
        alpha = 0.96;
      } else if (processing && animate) {
        const bump = Math.exp(-(((i - sweep) / 1.7) ** 2));
        height = BAR_WIDTH + 8 * bump;
        alpha = 0.4 + 0.6 * bump;
      } else if (processing) {
        // Reduced motion: the row breathes in place instead of travelling.
        alpha = 0.55 + 0.3 * Math.sin(this._clock * 3);
      } else if (this._paused) {
        alpha = 0.45;
      }

      const k = 1 - Math.exp(-dt / 0.045);
      bar.height += (height - bar.height) * k;
      bar.alpha += (alpha - bar.alpha) * k;
      if (Math.abs(height - bar.height) > 0.05) moving = true;
    });
    this._barsMoving = moving;
  }

  // The pill body in canvas units.
  _bodyRect() {
    const sp = this._springs;
    const press = 1 - 0.03 * sp.press.value;
    const w = sp.w.value * press;
    const h = sp.h.value * press;
    const cx = CANVAS_W / 2;
    const bottom = CANVAS_H - sp.lift.value;
    return { x: cx - w / 2, y: bottom - h, w, h, cx, cy: bottom - h / 2 };
  }

  _syncActors() {
    const s = this._scale;
    const body = this._bodyRect();
    const visible = this._visualState() !== "hidden";

    if (visible) {
      this._hit.set_position(
        Math.round((body.x - HIT_PAD) * s),
        Math.round((body.y - HIT_PAD) * s)
      );
      this._hit.set_size(
        Math.round((body.w + HIT_PAD * 2) * s),
        Math.round((body.h + HIT_PAD * 2) * s)
      );
    }
    if (this._hit.visible !== visible) this._hit.visible = visible;

    if (this._label.opacity > 0 || this._labelMarkup) {
      const [, natural] = this._label.get_preferred_width(-1);
      const [, height] = this._label.get_preferred_height(-1);
      this._label.set_position(
        Math.round((CANVAS_W * s - natural) / 2),
        Math.round((body.y - 9) * s - height)
      );
    }
  }

  // ------------------------------------------------------------------ label

  _showLabel(markup, autoHideMs = 0) {
    this._clearTimeout("_labelTimeoutId");
    if (markup && autoHideMs > 0) {
      this._labelTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        autoHideMs,
        () => {
          this._labelTimeoutId = 0;
          this._showLabel(null);
          return GLib.SOURCE_REMOVE;
        }
      );
    }
    if (markup === this._labelMarkup) return;
    const swap = markup && this._labelMarkup && this._label.opacity === 255;
    this._labelMarkup = markup;
    if (swap) {
      this._label.clutter_text.set_markup(markup);
      this._syncActors();
      return;
    }

    const fadeIn = () => {
      if (!this._labelMarkup) return;
      this._label.clutter_text.set_markup(this._labelMarkup);
      this._syncActors();
      this._label.translation_y = 4 * this._scale;
      this._label.ease({
        opacity: 255,
        translation_y: 0,
        duration: 220,
        mode: Clutter.AnimationMode.EASE_OUT_QUINT,
      });
    };

    if (this._label.opacity > 0) {
      this._label.ease({
        opacity: 0,
        duration: 110,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped: (finished) => {
          if (finished) fadeIn();
        },
      });
    } else {
      fadeIn();
    }
  }

  _idleHintMarkup() {
    const shortcut = this._shortcutLabel
      ? `  <span alpha="58%">${GLib.markup_escape_text(this._shortcutLabel, -1)}</span>`
      : "";
    return `Click to dictate${shortcut}`;
  }

  // ------------------------------------------------------------------ input

  _onHoverChanged() {
    this._hovered = this._hit.hover;
    this._clearTimeout("_hoverTimeoutId");
    if (!this._hovered) {
      this._zone = null;
      this._pressedZone = null;
      this._springs.press.to(0, STIFF_FEEDBACK);
    }
    this._applyTargets();
    this._applyZoneFeedback();

    if (this._state === "idle") {
      if (this._hovered) {
        this._hoverTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          260,
          () => {
            this._hoverTimeoutId = 0;
            if (this._hovered && this._state === "idle")
              this._showLabel(this._idleHintMarkup());
            return GLib.SOURCE_REMOVE;
          }
        );
      } else {
        this._showLabel(null);
      }
    }
    this._wake();
  }

  _zoneAt(event) {
    if (!event) return this._hovered ? "body" : null;
    const [stageX, stageY] = event.get_coords();
    const [ok, localX, localY] = this._stage.transform_stage_point(
      stageX,
      stageY
    );
    if (!ok) return null;
    const x = localX / this._scale;
    const y = localY / this._scale;
    const body = this._bodyRect();

    const recording = this._state === "recording";
    if (recording || this._state === "speaking") {
      const reach = BUTTON_RADIUS + 3;
      const cancelX = body.x + BUTTON_INSET;
      const stopX = body.x + body.w - BUTTON_INSET;
      if (recording && Math.hypot(x - cancelX, y - body.cy) <= reach)
        return "cancel";
      if (recording) {
        if (Math.hypot(x - stopX, y - body.cy) <= reach) return "stop";
      } else {
        // The buttons of a pair touch, so the nearer one takes the pointer.
        const near = (first, second, firstX) => {
          const a = Math.hypot(x - firstX, y - body.cy);
          const b = Math.hypot(x - firstX - BUTTON_PITCH, y - body.cy);
          return Math.min(a, b) <= reach ? (a <= b ? first : second) : null;
        };
        const zone =
          near("slower", "faster", cancelX) ??
          near("pause", "stop", stopX - BUTTON_PITCH);
        if (zone) return zone;
      }
    }
    return "body";
  }

  _updateZone(event = null) {
    const zone = this._hovered ? this._zoneAt(event) : null;
    if (zone === this._zone) return;
    this._zone = zone;
    this._applyZoneFeedback();
    this._wake();
  }

  _applyZoneFeedback() {
    const sp = this._springs;
    const recording = this._state === "recording";
    const speaking = this._state === "speaking";
    // A click on the body does what the main button does: stop a recording,
    // pause or carry on with a reading.
    const main = this._zone === "body";
    sp.cancelHover.to(recording && this._zone === "cancel" ? 1 : 0, STIFF_FEEDBACK);
    sp.slowerHover.to(speaking && this._zone === "slower" ? 1 : 0, STIFF_FEEDBACK);
    sp.fasterHover.to(speaking && this._zone === "faster" ? 1 : 0, STIFF_FEEDBACK);
    sp.pauseHover.to(
      speaking && (this._zone === "pause" || main) ? 1 : 0,
      STIFF_FEEDBACK
    );
    sp.stopHover.to(
      (recording || speaking) && (this._zone === "stop" || (recording && main))
        ? 1
        : 0,
      STIFF_FEEDBACK
    );
  }

  _onPress(event) {
    if (event.get_button() !== Clutter.BUTTON_PRIMARY)
      return Clutter.EVENT_PROPAGATE;
    this._updateZone(event);
    this._pressedZone = this._zone;
    this._springs.press.to(1, STIFF_FEEDBACK);
    this._wake();
    return Clutter.EVENT_STOP;
  }

  _onRelease(event) {
    const button = event.get_button();
    if (button === Clutter.BUTTON_SECONDARY) {
      if (this._state === "idle") this._actions.onSecondary?.();
      return Clutter.EVENT_STOP;
    }
    if (button !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;

    this._updateZone(event);
    const zone = this._zone;
    const pressed = this._pressedZone;
    this._pressedZone = null;
    this._springs.press.to(0, STIFF_FEEDBACK);
    this._wake();
    if (zone && zone === pressed) this._activate(zone);
    return Clutter.EVENT_STOP;
  }

  _onTouch(event) {
    if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
      this._hovered = true;
      this._updateZone(event);
      this._pressedZone = this._zone;
      return Clutter.EVENT_STOP;
    }
    if (event.type() === Clutter.EventType.TOUCH_END) {
      const zone = this._pressedZone;
      this._pressedZone = null;
      this._hovered = false;
      if (zone) this._activate(zone);
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }

  _activate(zone) {
    switch (this._state) {
      case "idle":
        this._showLabel(null);
        this._actions.onStart?.();
        break;
      case "recording":
        if (zone === "cancel") this._actions.onCancel?.();
        else this._actions.onStop?.();
        break;
      case "speaking":
        if (zone === "slower") this._actions.onSlower?.();
        else if (zone === "faster") this._actions.onFaster?.();
        else if (zone === "stop") this._actions.onStopSpeaking?.();
        else this._actions.onPauseToggle?.();
        break;
      case "done":
      case "error":
        this.setState("idle");
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ paint

  _paint(area) {
    const cr = area.get_context();
    const s = this._scale;
    const sp = this._springs;
    const body = this._bodyRect();
    const radius = body.h / 2;

    cr.scale(s, s);
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.OVER);

    const fill = sp.fill.value;
    if (fill > 0.004) {
      // Soft shadow: stacked rings fading outwards, offset downwards.
      const elev = sp.elev.value;
      if (elev > 0.01) {
        const layers = 9;
        for (let i = layers; i >= 1; i--) {
          const spread = i * 1.5;
          const alpha = 0.045 * elev * fill * (1 - i / (layers + 1));
          cr.setSourceRGBA(0, 0, 0, alpha);
          roundedRect(
            cr,
            body.x - spread,
            body.y - spread + 3 + 2 * elev,
            body.w + spread * 2,
            body.h + spread * 2,
            radius + spread
          );
          cr.fill();
        }
      }

      cr.setSourceRGBA(INK[0], INK[1], INK[2], fill);
      roundedRect(cr, body.x, body.y, body.w, body.h, radius);
      cr.fill();

      // Hairline: brighter along the top edge, so the pill holds its outline
      // on dark windows as well as light ones.
      const border = sp.border.value;
      const edge = new Cairo.LinearGradient(0, body.y, 0, body.y + body.h);
      edge.addColorStopRGBA(0, 1, 1, 1, Math.min(1, border * 1.5));
      edge.addColorStopRGBA(1, 1, 1, 1, border * 0.7);
      cr.setSource(edge);
      cr.setLineWidth(1);
      roundedRect(
        cr,
        body.x + 0.5,
        body.y + 0.5,
        body.w - 1,
        body.h - 1,
        radius - 0.5
      );
      cr.stroke();
    }

    cr.save();
    roundedRect(cr, body.x, body.y, body.w, body.h, radius);
    cr.clip();
    this._paintBars(cr, body);
    this._paintButtons(cr, body);
    this._paintCheck(cr, body);
    this._paintAlert(cr, body);
    cr.restore();

    cr.$dispose();
  }

  _paintBars(cr, body) {
    const strength = this._springs.bars.value;
    if (strength < 0.01) return;
    const span = (BAR_COUNT - 1) * BAR_PITCH;
    // The row tightens as the pill opens, like dots settling into place.
    const spread = 0.82 + 0.18 * strength;
    const centre = body.cx + this._springs.barsShift.value;

    this._bars.forEach((bar, i) => {
      const x = centre + (i * BAR_PITCH - span / 2) * spread;
      const height = Math.min(bar.height, Math.max(BAR_WIDTH, body.h - 12));
      cr.setSourceRGBA(1, 1, 1, bar.alpha * strength);
      roundedRect(
        cr,
        x - BAR_WIDTH / 2,
        body.cy - height / 2,
        BAR_WIDTH,
        height,
        BAR_WIDTH / 2
      );
      cr.fill();
    });
  }

  _paintButtons(cr, body) {
    const sp = this._springs;

    const cancel = sp.cancel.value;
    if (cancel > 0.01) {
      const x = body.x + BUTTON_INSET;
      const r = BUTTON_RADIUS * (0.7 + 0.3 * cancel);
      cr.setSourceRGBA(1, 1, 1, (0.1 + 0.1 * sp.cancelHover.value) * cancel);
      cr.arc(x, body.cy, r, 0, Math.PI * 2);
      cr.fill();

      const arm = 4.2 * (0.7 + 0.3 * cancel);
      cr.setSourceRGBA(1, 1, 1, (0.78 + 0.22 * sp.cancelHover.value) * cancel);
      cr.setLineWidth(1.7);
      cr.setLineCap(Cairo.LineCap.ROUND);
      cr.moveTo(x - arm, body.cy - arm);
      cr.lineTo(x + arm, body.cy + arm);
      cr.moveTo(x + arm, body.cy - arm);
      cr.lineTo(x - arm, body.cy + arm);
      cr.stroke();
    }

    // While reading aloud: slower and faster as a minus and a plus, and
    // pause, which turns into play while the reading is on hold.
    const controls = sp.controls.value;
    if (controls > 0.01) {
      const grow = 0.7 + 0.3 * controls;
      const r = BUTTON_RADIUS * grow;
      const disc = (x, hover) => {
        cr.setSourceRGBA(1, 1, 1, (0.1 + 0.1 * hover) * controls);
        cr.arc(x, body.cy, r, 0, Math.PI * 2);
        cr.fill();
      };

      const arm = 4.6 * grow;
      [sp.slowerHover.value, sp.fasterHover.value].forEach((hover, i) => {
        const x = body.x + BUTTON_INSET + i * BUTTON_PITCH;
        disc(x, hover);
        cr.setSourceRGBA(1, 1, 1, (0.78 + 0.22 * hover) * controls);
        cr.setLineWidth(1.7);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(x - arm, body.cy);
        cr.lineTo(x + arm, body.cy);
        if (i === 1) {
          cr.moveTo(x, body.cy - arm);
          cr.lineTo(x, body.cy + arm);
        }
        cr.stroke();
      });

      const x = body.x + body.w - BUTTON_INSET - BUTTON_PITCH;
      const hover = sp.pauseHover.value;
      const paused = clamp01(sp.paused.value);
      const ink = (0.78 + 0.22 * hover) * controls;
      disc(x, hover);
      if (paused < 0.99) {
        cr.setSourceRGBA(1, 1, 1, ink * (1 - paused));
        for (const side of [-1, 1]) {
          roundedRect(cr, x + side * 2.9 * grow - 1.3, body.cy - 4.6 * grow, 2.6, 9.2 * grow, 1.3);
          cr.fill();
        }
      }
      if (paused > 0.01) {
        const half = 5 * grow;
        cr.setSourceRGBA(1, 1, 1, ink * paused);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(1.4);
        // Nudged right: a triangle's weight sits left of its box.
        cr.moveTo(x - half * 0.62, body.cy - half);
        cr.lineTo(x + half * 0.9, body.cy);
        cr.lineTo(x - half * 0.62, body.cy + half);
        cr.closePath();
        cr.fillPreserve();
        cr.stroke();
      }
    }

    const stop = sp.stop.value;
    if (stop > 0.01) {
      const x = body.x + body.w - BUTTON_INSET;
      const r = BUTTON_RADIUS * (0.7 + 0.3 * stop);
      const lift = 0.07 * sp.stopHover.value;
      cr.setSourceRGBA(
        STOP_RED[0] + lift,
        STOP_RED[1] + lift,
        STOP_RED[2] + lift,
        stop
      );
      cr.arc(x, body.cy, r, 0, Math.PI * 2);
      cr.fill();

      const half = 4.4 * (0.7 + 0.3 * stop);
      cr.setSourceRGBA(1, 1, 1, stop);
      roundedRect(cr, x - half, body.cy - half, half * 2, half * 2, 2);
      cr.fill();
    }
  }

  _paintCheck(cr, body) {
    const progress = clamp01(this._springs.check.value);
    if (progress < 0.02) return;
    const points = [
      [-6, 0.5],
      [-2, 4.5],
      [6.2, -4.2],
    ];
    const first = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
    const second = Math.hypot(points[2][0] - points[1][0], points[2][1] - points[1][1]);
    const drawn = (first + second) * progress;

    cr.setSourceRGBA(1, 1, 1, Math.min(1, progress * 3));
    cr.setLineWidth(2);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.moveTo(body.cx + points[0][0], body.cy + points[0][1]);
    if (drawn <= first) {
      const t = drawn / first;
      cr.lineTo(
        body.cx + points[0][0] + (points[1][0] - points[0][0]) * t,
        body.cy + points[0][1] + (points[1][1] - points[0][1]) * t
      );
    } else {
      const t = (drawn - first) / second;
      cr.lineTo(body.cx + points[1][0], body.cy + points[1][1]);
      cr.lineTo(
        body.cx + points[1][0] + (points[2][0] - points[1][0]) * t,
        body.cy + points[1][1] + (points[2][1] - points[1][1]) * t
      );
    }
    cr.stroke();
  }

  _paintAlert(cr, body) {
    const strength = clamp01(this._springs.glyph.value);
    if (strength < 0.02) return;
    cr.setSourceRGBA(AMBER[0], AMBER[1], AMBER[2], strength);
    cr.setLineWidth(2.2);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.moveTo(body.cx, body.cy - 6);
    cr.lineTo(body.cx, body.cy + 1);
    cr.stroke();
    cr.arc(body.cx, body.cy + 5.6, 1.3, 0, Math.PI * 2);
    cr.fill();
  }

  // ---------------------------------------------------------------- helpers

  _clearTimeout(field) {
    if (this[field]) {
      GLib.source_remove(this[field]);
      this[field] = 0;
    }
  }
}
