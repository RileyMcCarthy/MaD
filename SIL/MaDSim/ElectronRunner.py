import os
import shutil
import subprocess
import threading
from . import logger


class ElectronRunner:
    def __init__(self, sil_root: str, project_root: str, skip_build: bool = False, headed: bool = False):
        self.sil_root = sil_root
        self.project_root = project_root
        self.skip_build = skip_build
        self.headed = headed
        self.running = False
        self.proc = None
        self.output_thread = None

    def _read_output(self, process):
        while self.running:
            line = process.stdout.readline()
            if line == '' and process.poll() is not None:
                break
            if line:
                logger.info("PLAYWRIGHT - " + line.strip() + "\x1b[0m")
        process.kill()
        self.running = False

    def _ensure_dir(self, path: str):
        if not os.path.isdir(path):
            os.makedirs(path, exist_ok=True)

    def ensure_playwright_ready(self):
        """Ensure npm deps for SIL test runner (idempotent)."""
        subprocess.check_call(['npm', 'install'], cwd=self.sil_root)

    def ensure_app_built(self):
        """Build the Electron app (npm run build) in-place under Software/MaDControl.

        No copying or reuse of prebuilt artifacts; always rely on the source tree.
        """
        app_src = os.path.join(self.project_root, 'Software', 'MaDControl')

        if not self.skip_build:
            subprocess.check_call(['npm', 'install'], cwd=app_src)
        else:
            logger.info('skip_build=True; will not run npm build')

        logger.info('MaDControl build ready')

    def prepare_for_tests(self):
        """Prepare artifacts and deps for running Playwright tests."""
        self.ensure_app_built()
        self.ensure_playwright_ready()

    def prepare_for_app(self):
        """Prepare artifacts to run the Electron app without tests."""
        self.ensure_app_built()

    def _spawn(self, cmd, cwd, label):
        """Spawn a subprocess and stream output via logger."""
        if self.running:
            self.stop()
        self.running = True
        logger.info(f'Starting {label}...')
        env = os.environ.copy()
        env.pop('ELECTRON_RUN_AS_NODE', None)
        self.proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            env=env,
        )
        self.output_thread = threading.Thread(target=self._read_output, args=(self.proc,))
        self.output_thread.start()

    def run_tests(self):
        cmd = ['npx', 'playwright', 'test', '--project=electron']
        if self.headed:
            cmd.insert(3, '--headed')
        self._spawn(cmd, self.sil_root, 'Playwright tests')

    def run_app(self):
        """Run the Electron app without Playwright tests (dev start)."""
        app_src = os.path.join(self.project_root, 'Software', 'MaDControl')
        self._spawn(['npm', 'start'], app_src, 'Electron app')

    def stop(self):
        self.running = False
        if self.proc is not None:
            self.proc.kill()
            self.proc = None
        if self.output_thread is not None:
            self.output_thread.join()
            self.output_thread = None
        logger.info('Electron process stopped')

    def is_running(self):
        return self.running

    def has_finished(self):
        return (self.proc is not None) and (self.proc.poll() is not None)


