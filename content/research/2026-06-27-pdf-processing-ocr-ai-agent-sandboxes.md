---
date: "2026-06-27"
title: "PDF Processing and OCR in AI Agent Sandboxes: The Detect-Then-Branch Pattern"
description: "How autonomous AI agents handle the fundamental split between text-layer and image-based PDFs, why sandboxed runtimes make OCR hard, and the practical fallback chains — from pdfplumber to vision-model rendering — that make PDF ingestion reliable in production."
tags:
  - pdf-processing
  - ocr
  - ai-agents
  - sandboxing
  - document-ai
  - multimodal
  - tool-reliability
  - production-patterns
---

## Executive Summary

- **Two classes of PDF, one wrong assumption**: Almost every PDF ingestion pipeline makes the same mistake — it assumes all PDFs have a text layer. In reality, PDFs divide into text-layer (vectorized), image-based (scanned), and mixed documents. The extraction path must branch on document type, not guess.
- **Sandbox environments break traditional OCR**: Autonomous agents running in sandboxed runtimes (Claude Code, GitHub Actions, E2B microVMs, Docker containers) typically cannot install Tesseract via system package managers, lack GPU access for PaddleOCR, and cannot guarantee that cloud OCR API credentials are present.
- **The vision-model fallback is now production-viable**: Using a multimodal LLM (Claude's native PDF support, GPT-4o vision, Gemini 1.5 Pro) to read PDF pages rendered as images sidesteps the OCR dependency entirely. The tradeoff is token cost — a 50-page dense PDF rendered at reasonable resolution can consume 50,000–100,000 tokens.
- **Three-tier fallback chain covers nearly all cases**: (1) direct text extraction for text-layer PDFs; (2) vision-model rendering for documents without a text layer or with unreliable text layers; (3) cloud OCR API (AWS Textract, Google Document AI, Mistral OCR) for cases where token budget makes vision expensive or the LLM is not multimodal.
- **New preprocessing tools changed the equation in 2025**: `marker` (by Vik Paruchuri, using Surya OCR under the hood) and IBM's `docling` provide pipeline-style PDF → Markdown conversion that handles the text/image split automatically, works offline, and produces structured output suitable for downstream LLM ingestion.
- **The right tool depends on four axes**: whether OCR is available in the runtime, token budget, accuracy requirements, and whether the document is structured (tables, forms) or unstructured prose.

---

## The Core Problem: Two Types of PDF, One Wrong Assumption

Every PDF is either a text-layer document, an image-based document, or a mix of both. This distinction is not obvious from the file extension or file size — a 5 MB PDF could be either.

**Text-layer PDFs** (also called vectorized PDFs) embed character data directly into the file. Programs like Word, LaTeX, or Figma export this type. The text is selectable in a PDF viewer, can be copied, and is extractable by any PDF parsing library without OCR. Most PDFs produced digitally — contracts from DocuSign, invoices from accounting software, academic papers from LaTeX — are text-layer.

**Image-based PDFs** are essentially collections of rasterized images. Scanned physical documents always produce this type. Some document workflows (printing then scanning, photographing documents) produce this type. Some legacy systems (early 2000s insurance software) exported PDFs by converting screens to images. The text is not selectable, not searchable without OCR, and completely inaccessible to standard text extraction.

**Mixed PDFs** are the most dangerous: some pages have a text layer, others do not. An email attachment might be a digitally typed cover letter (text-layer) stapled to a scanned supporting document (image). Treating the entire document as one type will either miss all scanned pages or waste time running OCR on pages that already have text.

The practical consequence: any agent that calls `pdftotext` or `PyPDF2.PdfReader` and receives an empty or near-empty string is encountering an image-based PDF, not a corrupt file or an encoding error. This distinction must drive the processing logic.

---

## Why Sandboxed Agent Runtimes Make OCR Hard

Traditional OCR pipelines assume a persistent server environment where Tesseract is installed, GPU hardware is available, and API credentials are configured in environment variables. None of these assumptions hold in most AI agent sandboxes.

### The Installation Barrier

Tesseract 5 requires a system package installation (`apt-get install tesseract-ocr` on Debian/Ubuntu). In sandboxed runtimes:

- **Claude Code**: runs in the user's local shell but in supervised sessions, system packages may be available if the user has sudo. Not guaranteed.
- **GitHub Actions**: a fresh Ubuntu runner does have apt-get, but each run starts from a clean image. Tesseract must be reinstalled every run, adding 30–60 seconds to every PDF-processing workflow.
- **E2B microVMs**: Firecracker-isolated VMs with a base image. Tesseract can be included in a custom template, but the default template does not include it.
- **Cloudflare Workers / V8 isolates**: No subprocess execution, no apt-get, no native binaries. Tesseract cannot run here at all.
- **Docker containers**: Only have what is in the image. A lean Python image (`python:3.12-slim`) has no Tesseract. Adding it increases image size by 40–150 MB depending on language packs.

The pattern across all these environments: OCR via Tesseract requires deliberate infrastructure setup. An agent that discovers it needs OCR mid-task cannot install Tesseract on demand.

### GPU Access

PaddleOCR and EasyOCR run on CPU but are dramatically faster on GPU. Surya (the OCR backbone of `marker`) requires significant CPU resources or GPU for practical speed on multi-page documents. E2B and Daytona sandbox platforms do not offer GPU access in their standard offerings (Modal is the exception). An agent processing a 200-page scanned document with CPU-only PaddleOCR faces a several-minute wait.

### Cloud API Credentials

Google Document AI, AWS Textract, and Azure Document Intelligence require API credentials. In a personal agent runtime, these credentials may not be configured. In a multi-tenant agent platform, the system operator may not have provisioned OCR API access. An agent that assumes cloud OCR is available will fail silently when credentials are absent.

---

## The Landscape of PDF Processing Tools

### Text Extraction Libraries (No OCR Required)

These tools work only on text-layer PDFs but are fast, offline, and have no external dependencies.

**pdftotext (poppler-utils)**: A CLI tool that wraps the poppler library. Invoked as `pdftotext input.pdf -` to write to stdout. Extremely fast (sub-second for most documents), produces clean output, handles multi-column layouts reasonably well. The `-layout` flag attempts to preserve spatial layout. Used internally by many higher-level tools.

**PyMuPDF (fitz)**: A Python binding for MuPDF. The fastest Python-native PDF library. `fitz.open()` loads a document; `page.get_text()` extracts text from a single page. Returns an empty string for image-based pages — which makes it useful for per-page type detection. Also provides `page.get_pixmap()` to render pages to images, making it the right choice when you need both text extraction and image rendering from one library.

**pdfplumber**: Built on pdfminer.six. The most accurate for structured extraction — tables, bounding boxes, character-level coordinates. Significantly slower than PyMuPDF on large documents. The `page.extract_table()` method is the best open-source option for table extraction from text-layer PDFs.

**pypdf (formerly PyPDF2)**: The most widely adopted but least accurate text extractor. Handles merging, splitting, and metadata well. Text extraction quality is inconsistent across PDF versions. Not recommended as the primary extractor but fine for simple metadata reading.

**pdf.js**: Mozilla's JavaScript PDF renderer. Runs in browsers and Node.js. Used by agents that process PDFs in a JavaScript runtime. Limited text extraction accuracy compared to poppler-based tools.

### OCR Engines (For Image-Based PDFs)

**Tesseract 5**: The dominant open-source OCR engine. Requires installation, supports 100+ languages via language packs (each ~1–50 MB). Python API via `pytesseract`. Accuracy on clean scanned documents: ~95–97% character accuracy. Performance: ~2–5 seconds per page on CPU for a standard A4 scan at 300 DPI. The key limitation for agent runtimes: it is a native binary that must be installed as a system package.

**Surya**: Released in 2024 by Vik Paruchuri (who later built `marker`). A transformer-based OCR model that significantly outperforms Tesseract on modern layouts, mixed-language documents, and low-quality scans. Runs as a Python package (`pip install surya-ocr`) without system-level installation — a significant advantage for sandbox environments. Requires ~2–4 GB VRAM for GPU inference or substantial CPU time for large documents. Available as an offline tool, making it viable when cloud APIs cannot be used.

**PaddleOCR**: Developed by Baidu, excellent for CJK (Chinese, Japanese, Korean) documents and multilingual mixed content. Python package (`pip install paddlepaddle paddleocr`). No system binary needed. Accuracy on English documents is comparable to Tesseract; significantly better on CJK. CPU inference is slow on multi-page documents; GPU inference is fast but requires CUDA setup.

**EasyOCR**: The simplest API of the three. `import easyocr; reader = easyocr.Reader(['en']); reader.readtext(image)`. Supports 80+ languages. CPU-only mode is viable for single-page documents or when speed is not critical. Accuracy is slightly below Tesseract for clean English documents but better for degraded or low-contrast scans.

### Cloud OCR APIs

Cloud APIs eliminate the installation and compute problem at the cost of per-page pricing, network latency, and a credential dependency.

**AWS Textract**: Strongest for structured documents (forms, tables, key-value pairs). The `DetectDocumentText` API returns plain text; `AnalyzeDocument` with `FORMS` and `TABLES` features returns structured extraction. Pricing: ~$1.50 per 1,000 pages for text detection, ~$15 per 1,000 pages for structured analysis. Latency: ~1–3 seconds per page for synchronous API; asynchronous bulk processing available.

**Google Document AI**: More general-purpose than Textract. The pre-trained processors cover invoices, identity documents, contracts, and general OCR. The `processDocument` API accepts base64-encoded PDF bytes or GCS URIs. Pricing: ~$1.50 per 1,000 pages for the OCR processor, higher for specialized processors. Language support is superior to Textract for non-Latin scripts.

**Azure Document Intelligence (formerly Form Recognizer)**: Microsoft's equivalent. Strong on Office-format documents and structured forms. The Read API provides pure OCR; the Prebuilt models handle invoices, receipts, and identity cards. Pricing similar to competitors.

**Mistral OCR**: Released in early 2025 as `mistral-ocr-latest`. Differentiates by producing Markdown output with embedded image placeholders, making it directly suitable for LLM ingestion without post-processing. Supports PDFs up to 1,000 pages. Pricing: ~$2 per 1,000 pages. The structured Markdown output (preserving headers, tables, lists) is particularly useful for downstream RAG pipelines.

**Mathpix**: Specialized for scientific content with mathematical notation. LaTeX output for equations. The best choice for academic papers, textbooks, and technical specifications. Pricing: subscription-based, higher than general OCR APIs. Overkill for most business documents.

### LLM-Native PDF Processing

The emergence of long-context multimodal models changed the calculus for PDF ingestion. Rather than extracting text and then passing it to a model, it is now viable to pass PDF pages directly to a vision-capable model and let it read the content.

**Claude's Native PDF Support**: Anthropic's Claude 3.5 and Claude 3 Sonnet/Haiku models accept PDFs directly as file attachments in the API (using the `document` content type with `media_type: application/pdf`). The model renders pages internally and reads both text-layer and image-based content. Maximum file size: 32 MB per document; maximum pages per document: 100 (as of mid-2026). This is the most reliable approach for mixed PDFs in agent environments where Anthropic API access is already available — no additional credentials or tool installation required.

**GPT-4o Vision (OpenAI)**: Does not natively accept PDFs but accepts base64-encoded images. The typical workflow: convert PDF pages to PNG/JPEG using `pdf2image` (which wraps pdftoppm from poppler), then pass page images as vision inputs. Supports up to 100 images per request. Token cost scales with image resolution — a 1024x1024 image at high detail costs ~765 tokens.

**Gemini 1.5 Pro / 2.0**: Google's model natively accepts PDFs via the File API. The 2 million token context window makes it the most capable for very long documents. The `file_api.upload_file()` method handles PDF upload; the file is referenced by URI in subsequent requests.

### PDF-to-Markdown Preprocessing Tools

**marker**: The most significant new entrant in 2024–2025. Converts PDFs to clean Markdown using a pipeline of Surya (for layout detection and OCR on image pages), column detection, table extraction, and heading inference. Produces Markdown that is directly suitable for LLM ingestion. Runs offline; `pip install marker-pdf` is the only dependency. CLI: `marker input.pdf --output-dir ./output`. Programmatic API available. Performance: ~5–30 seconds per page depending on hardware and document complexity. A key advantage: the caller does not need to know whether the PDF has a text layer — marker detects this per-page and routes accordingly.

**docling (IBM Research)**: Open-sourced in late 2024. More comprehensive than marker — handles PDFs, Word documents, HTML, PowerPoint, and images through a unified API. Uses specialized models for table structure recognition (TableFormer), figure classification, and reading order inference. Output formats: JSON with full document structure, Markdown, or custom. Integrates with LlamaIndex and LangChain as a loader. Installation: `pip install docling`. Heavier than marker due to the multiple specialized models.

**LlamaParse (LlamaIndex)**: A cloud API service (not self-hosted). Sends documents to LlamaIndex's servers, processes with a combination of OCR and LLMs, returns structured output. Pricing: ~$0.003 per page. The managed nature is an advantage (no install, no GPU) but a disadvantage (data leaves the local environment, requires internet and API key).

**Nougat (Meta AI)**: Specialized for scientific PDFs with mathematical notation. A vision transformer that reads PDF page images and produces LaTeX-compatible Markdown. Excellent for academic papers from arXiv; mediocre for business documents. Requires substantial GPU VRAM (NVIDIA A100/V100 class) for practical speed.

---

## The Detect-Then-Branch Pattern

The most reliable approach for agents is to make the PDF type determination explicit and route to the appropriate extraction path. This pattern — detect first, branch second — prevents silent failures where a scanned PDF returns empty text and the agent proceeds as if no content was found.

### Step 1: Detect PDF Type

```python
import fitz  # PyMuPDF

def classify_pdf_pages(pdf_path: str) -> dict:
    """Returns per-page classification: 'text', 'image', or 'mixed'."""
    doc = fitz.open(pdf_path)
    results = {}
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text().strip()
        
        # Heuristic: if fewer than 50 characters on a standard page,
        # treat as image-based. Adjust threshold for cover pages.
        if len(text) < 50:
            results[page_num] = "image"
        else:
            results[page_num] = "text"
    
    doc.close()
    
    page_types = set(results.values())
    if len(page_types) == 1:
        return {"type": page_types.pop(), "pages": results}
    return {"type": "mixed", "pages": results}
```

The character-count heuristic works for most cases. A refinement: check for high image-to-text-ratio on pages with some text (could indicate a scanned document with a thin text layer from a previous imperfect OCR pass, known as a "searchable PDF" or "sandwich PDF"). For these, comparing `page.get_text()` character count against `page.rect.width * page.rect.height / 500` (approximate characters expected in a dense page) identifies whether the existing text layer is reliable.

### Step 2: Route to Extraction Path

```python
from enum import Enum

class ExtractionPath(Enum):
    TEXT_LAYER = "text_layer"
    VISION_MODEL = "vision_model"
    CLOUD_OCR = "cloud_ocr"
    LOCAL_OCR = "local_ocr"

def select_extraction_path(
    pdf_type: str,
    has_cloud_ocr_credentials: bool,
    has_local_ocr: bool,
    vision_model_available: bool,
    page_count: int,
    token_budget: int,
) -> ExtractionPath:
    """Selects the appropriate extraction path based on PDF type and available tools."""
    
    if pdf_type == "text":
        return ExtractionPath.TEXT_LAYER
    
    # Image or mixed: OCR required
    # Estimated tokens for vision approach: ~1000 tokens per page (rough heuristic)
    vision_token_cost = page_count * 1000
    
    if has_cloud_ocr_credentials:
        return ExtractionPath.CLOUD_OCR
    
    if vision_model_available and vision_token_cost <= token_budget:
        return ExtractionPath.VISION_MODEL
    
    if has_local_ocr:
        return ExtractionPath.LOCAL_OCR
    
    # No OCR available: fall back to vision even if expensive,
    # or raise a descriptive error explaining the limitation
    if vision_model_available:
        return ExtractionPath.VISION_MODEL
    
    raise RuntimeError(
        f"Cannot process image-based PDF: no OCR engine available. "
        f"Install Tesseract ('apt-get install tesseract-ocr'), "
        f"configure cloud OCR credentials (AWS_ACCESS_KEY_ID + region), "
        f"or use a multimodal model."
    )
```

### Step 3: Execute the Selected Path

The three main execution paths each have a reference implementation.

**Text layer extraction (PyMuPDF):**
```python
def extract_text_layer(pdf_path: str) -> str:
    doc = fitz.open(pdf_path)
    pages = []
    for page in doc:
        pages.append(page.get_text("text"))
    doc.close()
    return "\n\n".join(pages)
```

**Vision model extraction (Claude API):**
```python
import anthropic
import base64

def extract_via_vision(pdf_path: str, client: anthropic.Anthropic) -> str:
    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()
    
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")
    
    response = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": pdf_b64,
                    },
                },
                {
                    "type": "text",
                    "text": "Extract all text from this document. Preserve structure, headings, and tables as Markdown. Return only the extracted content, no commentary."
                }
            ]
        }]
    )
    return response.content[0].text
```

**Local OCR via marker (no system dependencies):**
```python
from marker.convert import convert_single_pdf

def extract_via_marker(pdf_path: str) -> str:
    full_text, images, metadata = convert_single_pdf(pdf_path)
    return full_text  # Returns Markdown with embedded image references
```

---

## Production Patterns for Agent Systems

### Caching Rendered Pages

For mixed PDFs where individual pages are rendered to images (for vision model or OCR input), caching the renders avoids re-rendering on retries or when processing the same document multiple times. Page images should be stored using a content-addressed scheme (hash of PDF bytes + page number) to ensure cache invalidation when the source document changes.

```python
import hashlib
from pathlib import Path

def get_page_cache_path(pdf_path: str, page_num: int, cache_dir: Path) -> Path:
    with open(pdf_path, "rb") as f:
        pdf_hash = hashlib.sha256(f.read()).hexdigest()[:16]
    return cache_dir / f"{pdf_hash}_page{page_num:04d}.png"
```

### Token Budget Management for Long Documents

A 100-page PDF passed to a vision model can consume 50,000–150,000 tokens, which may exceed context limits or cost constraints. Strategies for managing this:

1. **Hierarchical extraction**: Extract a table of contents or executive summary first, then extract only relevant sections.
2. **Chunked processing**: Process 10–20 pages at a time, accumulate results.
3. **Priority pages**: If the agent knows which pages are relevant (from a prior metadata extraction), process only those.
4. **Summary-then-detail**: Use a fast text extraction to produce a rough outline; use vision model only for sections where the text layer fails.

### Retry Patterns

PDF processing can fail transiently (cloud API rate limits, network timeouts) or permanently (corrupt PDF, encryption). The agent should distinguish these:

```python
import tenacity

@tenacity.retry(
    retry=tenacity.retry_if_exception_type(RateLimitError),
    wait=tenacity.wait_exponential(multiplier=1, min=2, max=60),
    stop=tenacity.stop_after_attempt(4),
)
def extract_with_cloud_ocr(page_image_bytes: bytes) -> str:
    # Cloud OCR call here
    ...
```

Permanent failures (encrypted PDFs, zero-byte files, password-protected PDFs) should not be retried. PyMuPDF raises `fitz.fitz.FileDataError` for corrupt files and `fitz.fitz.PasswordError` for encrypted ones — catch these and return a structured error rather than retrying.

### Error Messages That Enable Recovery

When a PDF agent tool fails, the error message should tell the calling model what to do next — not just that the operation failed.

Instead of: `"PDF extraction failed"`

Return: `"This PDF appears to be image-based (0 characters extracted from text layer). OCR is required but not available in the current environment. Options: (1) configure AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_DEFAULT_REGION for Textract, (2) install tesseract-ocr via apt-get, or (3) pass the PDF URL to a vision-capable model directly."`

This error message gives the LLM enough information to either try an alternative approach or escalate to the user with a specific ask.

---

## Choosing the Right Stack

The right choice depends on four constraints: OCR availability, token budget, accuracy requirements, and whether the document is structured.

| Scenario | Recommended Stack |
|---|---|
| Text-layer PDF, any environment | PyMuPDF (`fitz`) — fast, zero dependencies |
| Text-layer PDF with tables | pdfplumber — accurate table extraction |
| Scanned PDF, Claude API available, under 100 pages | Claude native PDF support (document type) |
| Scanned PDF, no cloud APIs, Python environment | marker (`pip install marker-pdf`) |
| Scanned PDF, CJK content | PaddleOCR or Surya |
| Mixed PDF, general case | marker (handles per-page type detection automatically) |
| Scientific/academic PDF with math | Mathpix API or Nougat (GPU required) |
| Structured form/invoice extraction | AWS Textract AnalyzeDocument or Google Document AI |
| Very long document (100+ pages), token budget constrained | Cloud OCR (Textract/Document AI) + chunked summarization |
| No internet access, no system packages | Surya (transformer-based, pip-installable) |
| Multi-language mixed content | EasyOCR or PaddleOCR |

---

## The Zylos Context: What This Means in Practice

The real-world trigger for this research was a document processing task where a sandbox agent received a vectorized-text PDF — which extracts cleanly — but then encountered a subsequent file that was fully image-based. The agent had no OCR tool available and returned empty content, with no signal to the calling system that the failure was type-related rather than content-related.

The practical lesson: PDF processing code in any agent system needs to (1) probe the PDF type before attempting extraction, (2) have at least one fallback that works in the sandbox without system-level installation (vision model or a pip-installable OCR engine like Surya), and (3) return error messages that distinguish "no content found" from "content exists but is inaccessible due to missing tooling."

For the Zylos agent runtime specifically: because Claude is always available as a backend, the vision model path (passing the PDF to Claude with the `document` content type) provides a zero-configuration fallback that handles both text-layer and image-based PDFs without requiring any OCR installation. The tradeoff — token cost — is acceptable for occasional document processing but needs a token budget cap for bulk document pipelines.

The `marker` library represents the best offline alternative: a single pip install, no system binaries, reasonable CPU-only speed, and automatic handling of the text/image split. For agent systems that process documents in environments where cloud API calls add latency or cost overhead, marker is worth the ~200 MB model download at startup.

---

## Summary

PDF processing in autonomous agent systems is not a solved problem — it is a problem that is incorrectly assumed to be trivial. The fundamental distinction between text-layer and image-based documents must be detected at runtime and routed to the appropriate extraction path. Sandbox environments add a compounding constraint: the tools that make OCR easy (Tesseract, GPU-accelerated models, cloud API credentials) are often absent.

The practical solution is a defense-in-depth fallback chain:

1. **Probe first**: Use PyMuPDF's `page.get_text()` to detect whether a text layer exists, per page.
2. **Extract if available**: Use pdftotext or PyMuPDF for text-layer content — fast and accurate.
3. **Vision model as first fallback**: Pass image pages (or the full PDF via native document support) to a multimodal LLM. No installation required if the LLM API is already in use.
4. **Cloud OCR as second fallback**: Textract or Document AI for structured content, high accuracy, and when token budget is a concern.
5. **Offline OCR via pip**: Surya or marker when cloud APIs are unavailable and system package installation is not possible.
6. **Fail descriptively**: Never return empty content without telling the caller why and what alternatives exist.

The tools that matter most in 2026 are marker (offline, pip-installable, handles the text/image split automatically), Claude's native PDF document type (zero-configuration when using Claude as the backend model), and AWS Textract (most accurate for structured forms and tables). The combination of these three covers the vast majority of PDF processing needs in production agent systems.

---

*Sources: PyMuPDF documentation (pymupdf.readthedocs.io), marker repository (github.com/VikParuchuri/marker), docling documentation (ds4sd.github.io/docling), AWS Textract developer guide, Google Document AI product documentation, Anthropic Claude API PDF support documentation, Mistral OCR announcement (mistral.ai/news/mistral-ocr), Surya repository (github.com/VikParuchuri/surya), EasyOCR repository (github.com/JaidedAI/EasyOCR), PaddleOCR documentation (github.com/PaddlePaddle/PaddleOCR).*
