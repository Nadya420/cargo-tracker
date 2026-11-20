"""Compatibility entry point. The application implementation is in server.py."""
from pathlib import Path
import runpy

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('server.py')), run_name='__main__')
