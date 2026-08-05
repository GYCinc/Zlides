import io
import re
import zipfile
import xml.etree.ElementTree as ET


class FileParserPipeline:
    """
    Pipeline: Upload file -> extract real text content -> feed to slide agent or style bank.
    The Z.AI Agents API accepts text messages only (no file param), so files are
    parsed locally and their text is injected into the prompt.
    """

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def parse_pdf(self, content: bytes, filename: str, tier: str = "prime") -> dict:
        """Extract text from an uploaded file. Dispatches on extension.

        Returns {"markdown": extracted_text, "layout": {...}, "page_count": int}.
        Despite the name, handles pdf, docx, txt, md, csv and other text files.
        """
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

        if ext == "pdf":
            text, pages = self._extract_pdf(content)
        elif ext == "docx":
            text, pages = self._extract_docx(content), 1
        elif ext in ("txt", "md", "csv"):
            text, pages = self._extract_text(content), 1
        else:
            # Best-effort: try plain text decode, fall back to a clear notice
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                text = f"[Could not extract text from {filename}: unsupported binary format]"
            pages = 1

        text = text.strip()
        if not text:
            text = f"[No extractable text found in {filename}]"

        return {
            "markdown": f"# Content from {filename}\n\n{text}",
            "layout": {"pages": list(range(1, pages + 1))},
            "page_count": pages,
        }

    @staticmethod
    def _extract_pdf(content: bytes) -> tuple[str, int]:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(content))
        parts = []
        for i, page in enumerate(reader.pages, 1):
            page_text = (page.extract_text() or "").strip()
            if page_text:
                parts.append(f"## Page {i}\n\n{page_text}")
        return "\n\n".join(parts), len(reader.pages)

    @staticmethod
    def _extract_docx(content: bytes) -> str:
        """Extract paragraph text from a .docx (zip of XML) using stdlib only."""
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            xml_bytes = z.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        paragraphs = []
        for para in root.iter(f"{ns}p"):
            text = "".join(node.text or "" for node in para.iter(f"{ns}t"))
            if text.strip():
                paragraphs.append(text)
        return "\n\n".join(paragraphs)

    @staticmethod
    def _extract_text(content: bytes) -> str:
        for encoding in ("utf-8", "latin-1"):
            try:
                return content.decode(encoding)
            except UnicodeDecodeError:
                continue
        return re.sub(r"[^\x20-\x7e\n]", " ", content.decode("utf-8", errors="replace"))
