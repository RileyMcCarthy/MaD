VENV = venv
PYTHON = $(VENV)/bin/python3
PIP = $(VENV)/bin/pip
ACTIVATE = $(VENV)/bin/activate

.PHONY: clean install venv run setup test

install: venv

venvc: clean $(VENV)/bin/activate

venv: $(VENV)/bin/activate
	$(PYTHON) -m ensurepip --upgrade
	$(PIP) install --upgrade pip
	$(PIP) install -r requirements.txt

$(VENV)/bin/activate: requirements.txt
	python3 -m venv $(VENV)

run:
	$(PYTHON) Server.py --rebuild

playground:
	$(PYTHON) Server.py --rebuild --skip-tests --skip-app-build

setup:
	npm install
	$(MAKE) venv

clean:
	rm -rf $(VENV)
	find -iname "*.pyc" -delete
	rm -rf __pycache__
