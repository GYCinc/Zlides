class FileParserPipeline:
    """
    Pipeline: Upload PDF -> Parse layout -> Feed to slide agent or style bank
    """
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def parse_pdf(self, pdf_bytes: bytes, filename: str, tier: str = "prime") -> dict:
        """Mock for the parsing to return markdown and layout json."""
        return {
            "markdown": "# Parsed Content from " + filename + "\n\nHere is extracted text with layout hierarchy preserved.",
            "layout": {"pages": [1]},
            "page_count": 1
        }
