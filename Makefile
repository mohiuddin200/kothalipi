# Kothalipi Extension - Makefile
# Automates common development and installation tasks

EXTENSION_UUID = kothalipi@mohiuddin200.github.io
UPSTREAM_UUID = gnome-speech2text@kaveh.page
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(EXTENSION_UUID)
SOURCE_DIR = src
SCHEMAS_DIR = $(EXTENSION_DIR)/schemas
SCHEMA_ID = org.gnome.shell.extensions.kothalipi
SERVICE_INSTALLER = service/install-service.sh

# Optional: override the python interpreter used by the service installer.
# Example: make install-service PYTHON=python3.12
PYTHON ?=

.PHONY: help check shots dev use-fork use-original install compile-schemas install-service clean clean-service package status verify-schema

# Default target
help:
	@echo "Kothalipi Extension - Development Automation"
	@echo "=================================================="
	@echo ""
	@echo "Available targets:"
	@echo "  setup           - Clean install + full setup of both extension and D-Bus service"
	@echo "  clean           - Remove installed extension AND D-Bus service"
	@echo "  clean-service   - Remove only D-Bus service only"
	@echo "  status          - Check extension installation status"
	@echo "  install         - Link src/ into GNOME Shell + compile schemas"
	@echo "  check           - Load the fork in a headless test shell, report errors"
	@echo "  shots           - Screenshot the pill in every state (SHOTS_DIR=...)"
	@echo "  dev             - Open the fork in a windowed test shell"
	@echo "  use-fork        - Run the fork in the real session (after re-login)"
	@echo "  use-original    - Run the upstream extension in the real session"
	@echo "  compile-schemas - Compile GSettings schemas only"
	@echo "  install-service - Install the D-Bus service (supports PYTHON=... override)"
	@echo "  verify-schema   - Verify schema is properly installed"
	@echo "  package         - Create distribution package (development only)"
	@echo ""
	@echo "Usage: make <target>"

# Link the working tree into GNOME Shell and compile schemas.
# The extension directory is a symlink to src/, so edits need no reinstall.
install:
	@if [ -e "$(EXTENSION_DIR)" ] && [ ! -L "$(EXTENSION_DIR)" ]; then \
		echo "❌ $(EXTENSION_DIR) is a real directory; move it away first"; \
		exit 1; \
	fi
	@ln -sfn "$(CURDIR)/$(SOURCE_DIR)" "$(EXTENSION_DIR)"
	@glib-compile-schemas --strict $(SOURCE_DIR)/schemas
	@echo "✅ Linked $(EXTENSION_DIR) -> $(CURDIR)/$(SOURCE_DIR)"

# Load the fork in a throwaway headless shell and report errors
check:
	@dev/shell.sh check

# Play the pill through every state in a headless shell and save screenshots
SHOTS_DIR ?= /tmp/kothalipi-shots
shots:
	@dev/shell.sh shots "$(SHOTS_DIR)"

# Open the fork in a windowed test shell (needs mutter-dev-bin)
dev:
	@dev/shell.sh dev

# Pick which copy runs in the real session (takes effect after re-login)
use-fork:
	@dev/switch.sh fork

use-original:
	@dev/switch.sh original

# Compile GSettings schemas
compile-schemas:
	@echo "🔧 Compiling GSettings schemas..."
	@if [ ! -d "$(SCHEMAS_DIR)" ]; then \
		echo "❌ Schemas directory not found: $(SCHEMAS_DIR)"; \
		echo "   Run 'make install' first"; \
		exit 1; \
	fi
	@glib-compile-schemas $(SCHEMAS_DIR)
	@if [ -f "$(SCHEMAS_DIR)/gschemas.compiled" ]; then \
		echo "✅ Schemas compiled successfully!"; \
	else \
		echo "❌ Schema compilation failed"; \
		exit 1; \
	fi



# Complete setup process
setup: clean install compile-schemas install-service
	@echo ""
	@echo "🎉 Extension setup completed!"
	@echo "   The extension should now be available in GNOME Extensions."
	@echo ""
	@echo "🔄 Restart GNOME Shell to activate the extension:"
	@if [ "$(XDG_SESSION_TYPE)" = "x11" ]; then \
		echo "   Alt+F2 → r → Enter (or run: busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart()')"; \
	elif [ "$(XDG_SESSION_TYPE)" = "wayland" ]; then \
		echo "   ⚠️  Wayland detected - please log out and log back in"; \
	else \
		echo "   ⚠️  Unknown session type - manual restart required"; \
	fi

# Install the D-Bus service (Python + venv + D-Bus registration)
install-service:
	@echo "🧩 Installing Kothalipi D-Bus service..."
	@if [ ! -x "$(SERVICE_INSTALLER)" ]; then \
		echo "❌ Service installer not found or not executable: $(SERVICE_INSTALLER)"; \
		exit 1; \
	fi
	@if [ -n "$(PYTHON)" ]; then \
		echo "   Using Python override: $(PYTHON)"; \
		"$(SERVICE_INSTALLER)" --python "$(PYTHON)"; \
	else \
		"$(SERVICE_INSTALLER)"; \
	fi





# Clean installation (extension + D-Bus service)
clean:
	@echo "🧹 Removing installed extension..."
	@if [ -d "$(EXTENSION_DIR)" ]; then \
		rm -rf $(EXTENSION_DIR); \
		echo "✅ Extension removed from $(EXTENSION_DIR)"; \
	else \
		echo "ℹ️  Extension not found at $(EXTENSION_DIR)"; \
	fi
	@echo "🧹 Removing D-Bus service..."
	@PID=$$(ps aux | grep -E "kothalipi-service|kothalipi_service.py" | grep -v grep | awk '{print $$2}' | head -1); \
	if [ ! -z "$$PID" ]; then \
		echo "   Found process $$PID, terminating..."; \
		kill $$PID 2>/dev/null || true; \
		sleep 1; \
		echo "   Process terminated"; \
	else \
		echo "   No kothalipi processes found"; \
	fi
	@if [ -d "$(HOME)/.local/share/kothalipi-service" ]; then \
		rm -rf $(HOME)/.local/share/kothalipi-service; \
		echo "✅ Service directory removed"; \
	else \
		echo "ℹ️  Service directory not found"; \
	fi
	@if [ -f "$(HOME)/.local/share/dbus-1/services/io.github.mohiuddin200.Kothalipi.service" ]; then \
		rm $(HOME)/.local/share/dbus-1/services/io.github.mohiuddin200.Kothalipi.service; \
		echo "✅ D-Bus service file removed"; \
	else \
		echo "ℹ️  D-Bus service file not found"; \
	fi
	@if [ -f "$(HOME)/.local/share/applications/kothalipi-service.desktop" ]; then \
		rm $(HOME)/.local/share/applications/kothalipi-service.desktop; \
		echo "✅ Desktop entry removed"; \
	else \
		echo "ℹ️  Desktop entry not found"; \
	fi
	@echo "🧹 Resetting extension settings..."
	@gsettings reset $(SCHEMA_ID) first-run 2>/dev/null || echo "ℹ️  Settings already at defaults"
	@echo "🎯 Complete cleanup finished!"

# Create distribution package for GNOME Extensions store
package:
	@echo "📦 Creating distribution package for GNOME Extensions store..."
	@mkdir -p dist && \
	PACKAGE_DIR="$(EXTENSION_UUID)" && \
	PACKAGE_FILE="dist/$(EXTENSION_UUID).zip" && \
	echo "   Creating package directory: $$PACKAGE_DIR" && \
	rm -rf "$$PACKAGE_DIR" "$$PACKAGE_FILE" && \
	mkdir -p "$$PACKAGE_DIR" && \
	echo "   Copying extension files..." && \
	cp -r $(SOURCE_DIR)/* "$$PACKAGE_DIR/" && \
	echo "   Removing install-service.sh (now installed remotely from GitHub)..." && \
	rm -f "$$PACKAGE_DIR/install-service.sh" && \
	echo "   Validating schemas..." && \
	glib-compile-schemas --strict "$$PACKAGE_DIR/schemas/" && \
	echo "   Removing compiled schema (will be compiled on target system)..." && \
	rm -f "$$PACKAGE_DIR/schemas/gschemas.compiled" && \
	echo "   Service installer is now remote-only (downloaded from GitHub)..." && \
	echo "   Creating ZIP package..." && \
	cd "$$PACKAGE_DIR" && \
	zip -r "../$$PACKAGE_FILE" . && \
	cd .. && \
	rm -rf "$$PACKAGE_DIR" && \
	echo "✅ Package created: $$PACKAGE_FILE" && \
	echo "   Size: $$(du -h "$$PACKAGE_FILE" | cut -f1)" && \
	echo "   Contents:" && \
	unzip -l "$$PACKAGE_FILE" | head -20 && \
	echo "   ..." && \
	echo "" && \
	echo "🎯 Package ready for submission to GNOME Extensions store!"



# Clean only D-Bus service (for testing)
clean-service:
	@echo "🧹 Removing D-Bus service only..."
	@PID=$$(ps aux | grep -E "kothalipi-service|kothalipi_service.py" | grep -v grep | awk '{print $$2}' | head -1); \
	if [ ! -z "$$PID" ]; then \
		echo "   Found process $$PID, terminating..."; \
		kill $$PID 2>/dev/null || true; \
		sleep 1; \
		echo "   Process terminated"; \
	else \
		echo "   No kothalipi processes found"; \
	fi
	@if [ -d "$(HOME)/.local/share/kothalipi-service" ]; then \
		rm -rf $(HOME)/.local/share/kothalipi-service; \
		echo "✅ Service directory removed"; \
	else \
		echo "ℹ️  Service directory not found"; \
	fi
	@if [ -f "$(HOME)/.local/share/dbus-1/services/io.github.mohiuddin200.Kothalipi.service" ]; then \
		rm $(HOME)/.local/share/dbus-1/services/io.github.mohiuddin200.Kothalipi.service; \
		echo "✅ D-Bus service file removed"; \
	else \
		echo "ℹ️  D-Bus service file not found"; \
	fi
	@if [ -f "$(HOME)/.local/share/applications/kothalipi-service.desktop" ]; then \
		rm $(HOME)/.local/share/applications/kothalipi-service.desktop; \
		echo "✅ Desktop entry removed"; \
	else \
		echo "ℹ️  Desktop entry not found"; \
	fi
	@echo "🎯 D-Bus service cleanup finished!"





# Check if extension is enabled
status:
	@echo "📊 Extension Status:"
	@echo "   Directory: $(EXTENSION_DIR)"
	@if [ -d "$(EXTENSION_DIR)" ]; then \
		echo "   ✅ Installed"; \
	else \
		echo "   ❌ Not installed"; \
	fi
	@if [ -f "$(SCHEMAS_DIR)/gschemas.compiled" ]; then \
		echo "   ✅ Schemas compiled"; \
	else \
		echo "   ❌ Schemas not compiled"; \
	fi
	@echo "   Session: $(XDG_SESSION_TYPE)"
	@echo ""
	@echo "🔧 D-Bus Service Status:"
	@SERVICE_DIR="$(HOME)/.local/share/kothalipi-service" && \
	echo "   Directory: $$SERVICE_DIR" && \
	if [ -d "$$SERVICE_DIR" ]; then \
		echo "   ✅ Service installed"; \
		if [ -f "$$SERVICE_DIR/kothalipi-service" ]; then \
			echo "   ✅ Service executable found"; \
		else \
			echo "   ❌ Service executable missing"; \
		fi; \
		if [ -d "$$SERVICE_DIR/venv" ]; then \
			echo "   ✅ Virtual environment found"; \
		else \
			echo "   ❌ Virtual environment missing"; \
		fi; \
	else \
		echo "   ❌ Service not installed"; \
	fi
	@DBUS_SERVICE_FILE="$(HOME)/.local/share/dbus-1/services/io.github.mohiuddin200.Kothalipi.service" && \
	echo "   D-Bus service file: $$DBUS_SERVICE_FILE" && \
	if [ -f "$$DBUS_SERVICE_FILE" ]; then \
		echo "   ✅ D-Bus service file registered"; \
		echo "   📋 Service file contents:" && \
		cat "$$DBUS_SERVICE_FILE" | sed 's/^/      /'; \
	else \
		echo "   ❌ D-Bus service file not registered"; \
	fi
	@echo "   Process status:" && \
	PID=$$(ps aux | grep "kothalipi-service" | grep -v grep | awk '{print $$2}' | head -1); \
	if [ ! -z "$$PID" ]; then \
		echo "   ✅ Service running (PID: $$PID)"; \
		echo "   📋 Process details:" && \
		ps -p $$PID -o pid,ppid,cmd,etime | sed 's/^/      /'; \
		echo "   🔍 D-Bus service test:" && \
		if dbus-send --session --dest=io.github.mohiuddin200.Kothalipi --print-reply /io/github/mohiuddin200/Kothalipi io.github.mohiuddin200.Kothalipi.GetServiceStatus >/dev/null 2>&1; then \
			echo "   ✅ D-Bus service responding correctly"; \
		else \
			echo "   ❌ D-Bus service not responding"; \
		fi; \
	else \
		echo "   ❌ Service not running"; \
	fi

# Verify schema installation
verify-schema:
	@echo "🔍 Verifying schema installation..."
	@if [ -f "$(SCHEMAS_DIR)/$(SCHEMA_ID).gschema.xml" ]; then \
		echo "   ✅ Schema file found: $(SCHEMA_ID).gschema.xml"; \
	else \
		echo "   ❌ Schema file missing: $(SCHEMA_ID).gschema.xml"; \
		echo "   Available schemas:"; \
		ls -la $(SCHEMAS_DIR)/*.gschema.xml 2>/dev/null || echo "   No schema files found"; \
	fi
	@if [ -f "$(SCHEMAS_DIR)/gschemas.compiled" ]; then \
		echo "   ✅ Schema compiled successfully"; \
		echo "   ℹ️  Schema will be loaded by GNOME Shell when extension is enabled"; \
	else \
		echo "   ❌ Schema not compiled"; \
	fi 