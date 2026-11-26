"""Replace backend/README.md with the repository README, for PyPI. The release workflow runs this.

PyPI can't resolve paths inside the repository, so relative links become full
GitHub URLs (images load from raw.githubusercontent.com). Run before `uv build`. The short
README committed in backend/ is what source installs and CI use; don't commit the generated one.
"""
import re
from pathlib import Path

REPO = "https://github.com/godalida/marthouse"
RAW = "https://raw.githubusercontent.com/godalida/marthouse/main"
root = Path(__file__).resolve().parent.parent


def absolute(url: str, image: bool) -> str:
    if re.match(r"^([a-z]+:|#|/)", url):
        return url
    return f"{RAW}/{url}" if image else f"{REPO}/blob/main/{url}"


text = (root / "README.md").read_text()
text = re.sub(r'(<img\b[^>]*\bsrc=")([^"]+)"', lambda m: m[1] + absolute(m[2], True) + '"', text)
text = re.sub(r'(<a\b[^>]*\bhref=")([^"]+)"', lambda m: m[1] + absolute(m[2], False) + '"', text)
text = re.sub(r"(!\[[^\]]*\]\()([^)\s]+)", lambda m: m[1] + absolute(m[2], True), text)
text = re.sub(r"((?<!!)\[[^\]]*\]\()([^)\s]+)", lambda m: m[1] + absolute(m[2], False), text)
(root / "backend" / "README.md").write_text(text)
print("wrote backend/README.md")
