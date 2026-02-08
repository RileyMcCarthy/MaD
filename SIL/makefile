# MaD SIL Testing - Makefile
# 
# Commands:
#   make setup     - First-time setup (venv, npm, builds)
#   make test      - Run all tests (builds if needed, starts emulator, runs Playwright)
#   make playground - Start emulator + app for manual testing
#   make clean     - Remove build artifacts

VENV = venv
PYTHON = $(VENV)/bin/python3
PIP = $(VENV)/bin/pip

.PHONY: setup test playground clean build venv

# First-time setup
setup: venv
	npm install
	@echo "✅ Setup complete. Run 'make test' to run tests."

# Create Python virtual environment
venv: $(VENV)/bin/activate
	$(PIP) install --upgrade pip
	$(PIP) install -r requirements.txt

$(VENV)/bin/activate:
	python3 -m venv $(VENV)

# Run tests using Playwright (handles emulator via global setup)
test: venv
	npm test

# Start emulator + app for interactive development
playground: venv
	$(PYTHON) Server.py --skip-tests --run-app

# Clean build artifacts
clean:
	rm -rf $(VENV) test-results .emulator.pid build/firmware
	find . -name "*.pyc" -delete
	find . -name "__pycache__" -type d -delete

# Build all artifacts (firmware + app)
build:
	npm run build
