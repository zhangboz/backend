"""Package only deployment source; secrets and database dumps travel separately."""
from pathlib import Path
import hashlib
import tarfile

root = Path(__file__).resolve().parents[2]
output_dir = root / "backend/.local/oracle"
output_dir.mkdir(parents=True, exist_ok=True)
output = output_dir / "source.tar.gz"
files = set()

def include(path):
    resolved = path.resolve()
    if path.is_symlink() or not resolved.is_relative_to(root):
        raise ValueError("Deployment source must stay inside the workspace")
    if not path.is_file():
        raise FileNotFoundError(path.relative_to(root))
    relative = path.relative_to(root)
    if any(part in {".git", "node_modules", ".local", "backups", "uploads", "temp_exports", "secrets"} for part in relative.parts):
        raise ValueError("Runtime files cannot enter the source bundle")
    if path.name.startswith(".env") and path.name != ".env.example":
        raise ValueError("Environment secrets cannot enter the source bundle")
    files.add(path)

for name in ["package.json", "package-lock.json", "config.mjs", "db.mjs", "server.mjs"]:
    include(root / "backend" / name)
for directory in ["AI_ChatBot", "FileProcessor", "middleware", "routes", "services"]:
    for path in (root / "backend" / directory).glob("*.mjs"):
        include(path)
include(root / "backend/FileProcessor/reference.docx")
include(root / "backend/FileProcessor/exportSafety.lua")
for name in ["package.json", "package-lock.json"]:
    include(root / "web_frontend" / name)
for directory in ["public", "src"]:
    for path in (root / "web_frontend" / directory).rglob("*"):
        if path.is_file():
            include(path)
for name in [".env.example", "compose.yml", "backend.Dockerfile", "backend.Dockerfile.dockerignore",
             "web.Dockerfile", "web.Dockerfile.dockerignore", "Caddyfile", "README.md",
             "db-backup.sh", "db-restore-empty.sh"]:
    include(root / "deploy/oracle" / name)
with tarfile.open(output, "w:gz", format=tarfile.PAX_FORMAT) as archive:
    for path in sorted(files):
        info = archive.gettarinfo(str(path), arcname=path.relative_to(root).as_posix())
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        with path.open("rb") as content:
            archive.addfile(info, content)
with tarfile.open(output, "r:gz") as archive:
    if set(archive.getnames()) != {p.relative_to(root).as_posix() for p in files}:
        raise ValueError("Source archive verification failed")
print(f"Deployment source: {output}")
print(f"Verified {len(files)} files; {output.stat().st_size} bytes; SHA256 {hashlib.sha256(output.read_bytes()).hexdigest()}")
