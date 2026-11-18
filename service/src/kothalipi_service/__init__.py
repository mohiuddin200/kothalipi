"""Kothalipi Service

A D-Bus service that provides speech-to-text functionality for the GNOME Shell extension.
"""

__version__ = "1.3.0"
__author__ = "Kaveh Tehrani"
__email__ = "codemonkey13x@gmail.com"

from .service import KothalipiService

__all__ = ["KothalipiService"]
