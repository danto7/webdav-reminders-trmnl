# Install the reminders board as a system service + 5-minute timer.
#
#   make install     set up mise/node/deps, install and start the timer
#   make uninstall   stop and remove the units
#   make run         trigger one update now
#   make status      show timer and last run
#   make logs        follow the service log
#
# Run it either as the project owner (it calls sudo where needed) or as root,
# e.g. `sudo make install`. The service always runs as RUN_USER: the invoking
# user, or SUDO_USER when started via sudo, or root when logged in as root.
# Override if needed:
#   make install RUN_USER=daniel MISE=/usr/local/bin/mise

NAME     := webdav-reminders-trmnl
UNIT_DIR ?= /etc/systemd/system
WORKDIR  ?= $(CURDIR)
BUILD    := build

ME       := $(shell id -un)
RUN_USER ?= $(or $(SUDO_USER),$(ME))
# Privileged commands: plain when already root, via sudo otherwise.
SUDO     := $(if $(filter 0,$(shell id -u)),,sudo)
# Per-user setup (mise trust/install, npm ci) must run as RUN_USER so that
# mise state, the Node install and node_modules end up owned by that user.
AS_USER  := $(if $(filter $(RUN_USER),$(ME)),,sudo -u $(RUN_USER) -H)
# sudo resets PATH, so fall back to RUN_USER's login shell to find mise.
MISE     ?= $(or $(shell command -v mise),$(shell $(AS_USER) sh -lc 'command -v mise' 2>/dev/null))

SERVICE := $(BUILD)/$(NAME).service
TIMER   := systemd/$(NAME).timer

.PHONY: all preflight setup units install uninstall run status logs clean

all: units

setup:
	@test -n "$(MISE)" || { echo "mise not found; set MISE=/path/to/mise" >&2; exit 1; }
	@test -f .envrc || { echo ".envrc missing (CALDAV_URL, CALDAV_USER, CALDAV_PASSWORD, WEBHOOK_URL)" >&2; exit 1; }
	cd $(WORKDIR) && $(AS_USER) $(MISE) trust
	cd $(WORKDIR) && $(AS_USER) $(MISE) install
	cd $(WORKDIR) && $(AS_USER) $(MISE) run install

units: $(SERVICE)

$(SERVICE): systemd/$(NAME).service.in Makefile
	@test -n "$(MISE)" || { echo "mise not found; set MISE=/path/to/mise" >&2; exit 1; }
	@mkdir -p $(BUILD)
	sed -e 's|@USER@|$(RUN_USER)|g' \
	    -e 's|@WORKDIR@|$(WORKDIR)|g' \
	    -e 's|@MISE@|$(MISE)|g' $< > $@

preflight:
	@test ! -e /etc/NIXOS -o "$(UNIT_DIR)" != /etc/systemd/system || { echo "NixOS: /etc/systemd/system is read-only; declare the service in configuration.nix instead" >&2; exit 1; }

install: preflight setup units
	$(SUDO) install -m 644 $(SERVICE) $(TIMER) $(UNIT_DIR)/
	$(SUDO) systemctl daemon-reload
	$(SUDO) systemctl enable --now $(NAME).timer
	@echo "Installed. Next run: $$(systemctl show -P NextElapseUSecRealtime $(NAME).timer)"

uninstall:
	-$(SUDO) systemctl disable --now $(NAME).timer
	$(SUDO) rm -f $(UNIT_DIR)/$(NAME).service $(UNIT_DIR)/$(NAME).timer
	$(SUDO) systemctl daemon-reload

run:
	$(SUDO) systemctl start $(NAME).service

status:
	systemctl list-timers $(NAME).timer
	-systemctl status --no-pager $(NAME).service

logs:
	journalctl -u $(NAME).service -f

clean:
	rm -rf $(BUILD)
