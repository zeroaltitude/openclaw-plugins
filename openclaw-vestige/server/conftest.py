"""Root conftest for pytest — ensures the server package is importable."""

import sys
from pathlib import Path

# Add the server directory to sys.path so `from app.xxx import ...` works
# when running pytest from the repo root or from server/.
server_dir = Path(__file__).resolve().parent
if str(server_dir) not in sys.path:
    sys.path.insert(0, str(server_dir))
