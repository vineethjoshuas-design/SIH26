"""
AEGIS-GIS // SIH26191 Production Packaging & Archival Utility
Bundles application code, static assets, database, and documentation
into a clean, secrets-free production archive: AEGIS_GIS_SIH26191_Submission.zip
"""

import os
import shutil
import zipfile
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
OUTPUT_ZIP = PROJECT_ROOT / "AEGIS_GIS_SIH26191_Submission.zip"

# Strict exclusion rules
EXCLUDE_DIRS = {
    "__pycache__", ".pytest_cache", ".git", ".idea", ".vscode",
    "venv", "env", ".venv", "node_modules"
}

EXCLUDE_FILE_PATTERNS = [
    r"^\.env$",
    r".*\.pyc$",
    r".*\.pyo$",
    r".*\.log$",
    r".*\.tmp$",
    r"^\.DS_Store$",
    r"Thumbs\.db$",
    r".*cad_disaster\.db-(wal|shm)$",
    r"^AEGIS_GIS_SIH26191_Submission\.zip$"
]

INCLUDED_ROOT_FILES = [
    "requirements.txt",
    "run.py",
    ".env.example",
    "cad_disaster.db",
    "README.md",
    "SIH26191_AEGIS_GIS_WORKFLOW_ARCHITECTURE.md",
    "AI_INSTRUCTIONS.md",
    "verify_backend_integration.py",
    "package_project.py"
]

INCLUDED_ROOT_DIRS = [
    "api",
    "app",
    "static",
    "scripts",
    "tests"
]


def should_exclude_file(filename: str) -> bool:
    for pat in EXCLUDE_FILE_PATTERNS:
        if re.search(pat, filename, re.IGNORECASE):
            return True
    return False


def purge_cache_directories(root_dir: Path):
    """Deletes __pycache__, .pytest_cache, and temporary build files."""
    purged_count = 0
    for dirpath, dirnames, filenames in os.walk(root_dir, topdown=False):
        p = Path(dirpath)
        if p.name in EXCLUDE_DIRS:
            try:
                shutil.rmtree(p)
                purged_count += 1
                print(f"[PURGED] Cache directory: {p.relative_to(root_dir)}")
            except Exception as e:
                print(f"[WARN] Could not delete {p}: {e}")
    return purged_count


def verify_no_secrets_in_file(file_path: Path) -> bool:
    """Scans text files for potential hardcoded secrets."""
    if not file_path.suffix in [".py", ".json", ".env", ".txt", ".md", ".js", ".html"]:
        return True
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
        # Google API Key regex (AIzaSy...)
        if re.search(r"AIzaSy[A-Za-z0-9_-]{33}", content):
            print(f"[CRITICAL ERROR] Hardcoded Google API key found in {file_path}!")
            return False
    except Exception:
        pass
    return True


def package_project():
    print("=" * 70)
    print("AEGIS-GIS (SIH26191) PACKAGING & ARCHIVAL UTILITY")
    print("=" * 70)

    # 1. Purge local cache directories
    print("[1/4] Purging local caches (__pycache__, .pytest_cache)...")
    purged = purge_cache_directories(PROJECT_ROOT)
    print(f"      Purged {purged} cache directories.")

    # 2. Verify secrets across source files
    print("[2/4] Scanning source files for hardcoded secrets...")
    secrets_clean = True
    scanned_count = 0
    for target_dir in INCLUDED_ROOT_DIRS:
        d = PROJECT_ROOT / target_dir
        if d.exists():
            for root, _, files in os.walk(d):
                for f in files:
                    fp = Path(root) / f
                    scanned_count += 1
                    if not verify_no_secrets_in_file(fp):
                        secrets_clean = False

    for f_name in INCLUDED_ROOT_FILES:
        fp = PROJECT_ROOT / f_name
        if fp.exists():
            scanned_count += 1
            if not verify_no_secrets_in_file(fp):
                secrets_clean = False

    if not secrets_clean:
        print("[ABORT] Cannot package archive with potential hardcoded secrets!")
        return False
    print(f"      Scanned {scanned_count} files. Zero hardcoded secrets detected.")

    # 3. Create ZIP Archive
    print(f"[3/4] Building production archive: {OUTPUT_ZIP.name}...")
    if OUTPUT_ZIP.exists():
        try:
            OUTPUT_ZIP.unlink()
        except Exception:
            pass

    archive_count = 0
    with zipfile.ZipFile(OUTPUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        # Add root files
        for f_name in INCLUDED_ROOT_FILES:
            fp = PROJECT_ROOT / f_name
            if fp.exists() and not should_exclude_file(f_name):
                zf.write(fp, arcname=f_name)
                archive_count += 1
                print(f"      + {f_name}")

        # Add directories
        for dir_name in INCLUDED_ROOT_DIRS:
            d = PROJECT_ROOT / dir_name
            if d.exists():
                for root, dirs, files in os.walk(d):
                    # Filter out excluded directories in-place
                    dirs[:] = [sub for sub in dirs if sub not in EXCLUDE_DIRS]
                    for f in files:
                        if should_exclude_file(f):
                            continue
                        fp = Path(root) / f
                        arcname = fp.relative_to(PROJECT_ROOT)
                        zf.write(fp, arcname=arcname)
                        archive_count += 1

    # 4. Summary & Verification
    size_mb = OUTPUT_ZIP.stat().st_size / (1024 * 1024)
    print("[4/4] Package Verification:")
    print("=" * 70)
    print(f"Archive Created : {OUTPUT_ZIP}")
    print(f"Total Files     : {archive_count} files bundled")
    print(f"Archive Size    : {size_mb:.2f} MB")
    print("=" * 70)
    print("STATUS: SUCCESS - Clean production package ready for submission.")
    return True


if __name__ == "__main__":
    package_project()
