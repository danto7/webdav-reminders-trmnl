# Install the reminders board as a system service + 5-minute timer.
#
#   make install     set up mise/node/deps, install and start the timer (uses sudo)
#   make uninstall   stop and remove the units
#   make run         trigger one update now
#   make status      show timer and last run
#   make logs        follow the service log
#
# Run as the user that owns the project (not with sudo); override if needed:
#   make install RUN_USER=daniel MISE=/usr/local/bin/mise

NAME     := webdav-reminders-trmnl
UNIT_DIR ?= /etc/systemd/system
RUN_USER ?= $(shell id -un)
WORKDIR  ?= $(CURDIR)
MISE     ?= $(shell command -v mise)
BUILD    := build

SERVICE := $(BUILD)/$(NAME).service
TIMER   := systemd/$(NAME).timer

.PHONY: all setup units install uninstall run status logs clean

all: units

setup:
	@test "$$(id -u)" != 0 || { echo "Run make as the project owner, not with sudo (it calls sudo itself)" >&2; exit 1; }
	@test -n "$(MISE)" || { echo "mise not found; set MISE=/path/to/mise" >&2; exit 1; }
	@test -f .envrc || { echo ".envrc missing (CALDAV_URL, CALDAV_USER, CALDAV_PASSWORD, WEBHOOK_URL)" >&2; exit 1; }
	$(MISE) trust
	$(MISE) install
	$(MISE) run install

units: $(SERVICE)

$(SERVICE): systemd/$(NAME).service.in Makefile
	@test -n "$(MISE)" || { echo "mise not found; set MISE=/path/to/mise" >&2; exit 1; }
	@mkdir -p $(BUILD)
	sed -e 's|@USER@|$(RUN_USER)|g' \
	    -e 's|@WORKDIR@|$(WORKDIR)|g' \
	    -e 's|@MISE@|$(MISE)|g' $< > $@

install: setup units
	@test ! -e /etc/NIXOS -o "$(UNIT_DIR)" != /etc/systemd/system || { echo "NixOS: /etc/systemd/system is read-only; declare the service in configuration.nix instead" >&2; exit 1; }
	sudo install -m 644 $(SERVICE) $(TIMER) $(UNIT_DIR)/
	sudo systemctl daemon-reload
	sudo systemctl enable --now $(NAME).timer
	@echo "Installed. Next run: $$(systemctl show -P NextElapseUSecRealtime $(NAME).timer)"

uninstall:
	-sudo systemctl disable --now $(NAME).timer
	sudo rm -f $(UNIT_DIR)/$(NAME).service $(UNIT_DIR)/$(NAME).timer
	sudo systemctl daemon-reload

run:
	sudo systemctl start $(NAME).service

status:
	systemctl list-timers $(NAME).timer
	-systemctl status --no-pager $(NAME).service

logs:
	journalctl -u $(NAME).service -f

clean:
	rm -rf $(BUILD)
