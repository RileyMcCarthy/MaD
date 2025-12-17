import os
import shutil
import subprocess
import threading
from . import logger


class ElectronRunner:
    def __init__(self, sil_root: str, project_root: str, skip_build: bool = False, headed: bool = False, rebuild: bool = False):
        self.sil_root = sil_root
        self.project_root = project_root
        self.skip_build = skip_build
        self.headed = headed
        self.rebuild = rebuild
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
        # Ensure npm deps for SIL test runner (idempotent)
        subprocess.check_call(['npm', 'install'], cwd=self.sil_root)

    def ensure_app_built(self):
        """Build the Electron app (if needed) and move artifacts to SIL/build/MaDControl.

        Always refresh the destination from Software/MaDControl/release/app
        so Playwright runs against the latest build. If skip_build is True,
        we will not run the build, but will still try to copy existing artifacts.
        """
        app_src = os.path.join(self.project_root, 'Software', 'MaDControl')
        src_dir = os.path.join(app_src, 'release', 'app')
        dest_dir = os.path.join(self.sil_root, 'build', 'MaDControl')

        # Build if not skipping and source release doesn't exist yet
        if not self.skip_build:
            logger.info('Ensuring MaDControl build artifacts (npm run build)')
            if not os.path.isdir(os.path.join(app_src, 'node_modules')):
                subprocess.check_call(['npm', 'install'], cwd=app_src)
            subprocess.check_call(['npm', 'run', 'build'], cwd=app_src)
        else:
            logger.info('skip_build=True; will not run npm build')

        # Verify source exists
        if not os.path.isdir(src_dir):
            logger.warning(f'MaDControl source artifacts not found at {src_dir}')
            # If destination already has artifacts, keep them
            if os.path.isdir(dest_dir):
                logger.warning('Using existing SIL/build/MaDControl artifacts')
                return
            raise FileNotFoundError(f'Build artifacts missing at {src_dir} and none at {dest_dir}')

        # Refresh destination directory from source
        if self.rebuild and os.path.isdir(dest_dir):
            shutil.rmtree(dest_dir)
        self._ensure_dir(dest_dir)
        for name in os.listdir(dest_dir):
            p = os.path.join(dest_dir, name)
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
        for item in os.listdir(src_dir):
            s = os.path.join(src_dir, item)
            d = os.path.join(dest_dir, item)
            if os.path.isdir(s):
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)

        # Ensure preload path
        dll_dir = os.path.join(dest_dir, '.erb', 'dll')
        self._ensure_dir(dll_dir)
        preload_src = os.path.join(dest_dir, 'dist', 'main', 'preload.js')
        if os.path.isfile(preload_src):
            shutil.copy2(preload_src, os.path.join(dll_dir, 'preload.js'))

        # Also create optional alias directory with alternate casing if desired
        alias_dir = os.path.join(self.sil_root, 'build', 'MadControl')
        try:
            if not os.path.exists(alias_dir):
                os.symlink(dest_dir, alias_dir)
        except Exception:
            # If symlink not permitted, ignore
            pass

        logger.info('MaDControl artifacts prepared at SIL/build/MaDControl')

    def prepare(self):
        self.ensure_app_built()
        self.ensure_playwright_ready()

    def run_tests(self):
        if self.running:
            self.stop()
        self.running = True
        cmd = ['npx', 'playwright', 'test', '--project=electron']
        if self.headed:
            cmd.insert(3, '--headed')
        logger.info('Starting Playwright tests...')
        self.proc = subprocess.Popen(cmd, cwd=self.sil_root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.output_thread = threading.Thread(target=self._read_output, args=(self.proc,))
        self.output_thread.start()

    def stop(self):
        self.running = False
        if self.proc is not None:
            self.proc.kill()
            self.proc = None
        if self.output_thread is not None:
            self.output_thread.join()
            self.output_thread = None
        logger.info('Playwright tests stopped')

    def is_running(self):
        return self.running

    def has_finished(self):
        return (self.proc is not None) and (self.proc.poll() is not None)


