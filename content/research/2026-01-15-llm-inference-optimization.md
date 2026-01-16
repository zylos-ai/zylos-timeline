---
date: "2026-01-15"
title: "LLM Inference Optimization and Quantization 2026"
description: "Comprehensive guide to efficient LLM deployment covering quantization methods, inference frameworks, and production optimization techniques"
tags:
  - llm
  - inference
  - quantization
  - optimization
  - vllm
  - production
---


> Comprehensive guide to efficient LLM deployment covering quantization methods, inference frameworks, and production optimization techniques.

**Last Updated:** January 2026

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Quantization Methods](#quantization-methods)
3. [Inference Frameworks](#inference-frameworks)
4. [Speculative Decoding](#speculative-decoding)
5. [KV Cache Optimization](#kv-cache-optimization)
6. [Continuous Batching](#continuous-batching)
7. [Hardware Considerations](#hardware-considerations)
8. [Production Deployment Patterns](#production-deployment-patterns)
9. [Edge and Mobile Deployment](#edge-and-mobile-deployment)
10. [Benchmarks and Performance](#benchmarks-and-performance)
11. [Practical Recommendations](#practical-recommendations)

---

## Executive Summary

The LLM inference landscape has matured significantly in 2025-2026, with several key developments:

- **Quantization**: FP8 has emerged as the gold standard for quality/performance balance on Hopper GPUs
- **Frameworks**: vLLM dominates production deployments; SGLang leads in throughput with RadixAttention
- **Memory**: PagedAttention reduced KV cache waste from 60-80% to under 4%
- **Batching**: Continuous batching delivers up to 23x throughput improvement
- **Hardware**: H100 pricing dropped from $8/hr to ~$3/hr; B200s entering production

### Key Performance Numbers (2026)

| Metric | Typical Improvement |
|--------|---------------------|
| PagedAttention throughput | 2-4x vs traditional |
| FP8 vs FP16 speed | 30-33% faster |
| Speculative decoding | Up to 3x faster |
| Continuous batching | 23x throughput |
| FlashAttention-3 (H100) | 840 TFLOPS (85% utilization) |

---

## Quantization Methods

Quantization reduces numerical precision of model weights and activations, trading minimal quality for significant memory and speed gains.

### Overview of Methods

| Method | Bits | Target Hardware | Quality Retention | Best For |
|--------|------|-----------------|-------------------|----------|
| FP8 | 8 | NVIDIA Hopper+ | ~99% | Production GPU serving |
| AWQ | 4 | GPU | ~95% | Creative writing, coding |
| GPTQ | 4 | GPU | ~90% | Max throughput |
| GGUF | 2-8 | CPU/Apple Silicon | ~92% | Local/edge deployment |
| INT8 | 8 | General | ~97-99% | Wide compatibility |
| INT4 | 4 | General | ~90-95% | Memory-constrained |

### FP8 Quantization (Recommended for Production)

FP8 is the most stable option across model sizes, particularly on NVIDIA Hopper GPUs with native Transformer Engine support.

**Key Benefits:**
- Near-lossless quality (0.1-0.3% perplexity increase typical)
- 33% faster inference vs FP16
- 50% memory reduction for KV cache
- Native hardware acceleration on H100/H200

**Benchmark Results (Mistral 7B):**
```
FP8 vs FP16:
- Latency (TTFT): 8.5% decrease
- Speed (tokens/sec): 33% improvement
- Throughput: 31% increase
```

**Best Practices:**
```python
# vLLM FP8 inference
from vllm import LLM

llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    quantization="fp8",
    kv_cache_dtype="fp8"  # Recommended for Hopper
)
```

### GPTQ (GPU-Optimized)

Post-training quantization focused on GPU inference with excellent throughput.

**Characteristics:**
- Requires calibration dataset (quality depends on dataset selection)
- Excellent with Marlin kernels (2.5x faster than base GPTQ)
- Best raw throughput on NVIDIA GPUs
- Supports 2/3/4/8-bit quantization

**Performance Note:** Kernels matter more than algorithms. Marlin uses the same GPTQ weights but runs 2.5x faster thanks to optimized CUDA kernels.

```python
# GPTQ with Marlin kernels in vLLM
llm = LLM(
    model="TheBloke/Llama-2-70B-GPTQ",
    quantization="marlin"
)
```

### AWQ (Activation-Aware)

Preserves "salient" weights (top 1%) that carry most important information.

**Key Insight:** Not all weights are equally important. AWQ identifies and protects critical weights during quantization.

**Advantages:**
- No backpropagation required (faster quantization)
- Better quality preservation for creative/coding tasks
- Excellent GPU inference speeds
- 95% quality retention typical

**When to Use:**
- Creative writing applications
- Code generation
- Tasks requiring nuanced output
- Large models (70B+) where quality matters most

### GGUF (CPU/Edge Optimized)

The standard for CPU inference and Apple Silicon, evolved from GGML.

**Format Benefits:**
- Single-file format with embedded metadata
- Native support in llama.cpp, Ollama
- Flexible CPU/GPU offloading
- Wide quantization range (Q2_K to Q8_0)

**Quantization Levels:**
```
Q2_K:  ~2.5 bits/weight - Extreme compression, quality loss
Q4_K_M: ~4.5 bits/weight - Good balance (recommended)
Q5_K_M: ~5.5 bits/weight - Better quality, still fast
Q8_0:   8 bits/weight - Near-lossless
```

**Practical Guidance:**
- Use Q5_K_M for best quality/size balance
- GGUF has overhead in vLLM - stick to llama.cpp/Ollama
- Best for Apple Silicon where unified memory shines

### Quality Comparison by Task

| Task | Best Method | Notes |
|------|-------------|-------|
| Code Generation | GGUF Q5_K_M | 54.27% HumanEval (only 2% below baseline) |
| General Chat | AWQ/FP8 | Consistent quality across inputs |
| High Throughput | GPTQ/Marlin | Speed over quality |
| Long Context | FP8 | KV cache benefits |
| Edge/Mobile | GGUF Q4_K | Memory efficiency |

---

## Inference Frameworks

### Framework Comparison (2026)

| Framework | Best For | Throughput | Setup Time | Notes |
|-----------|----------|------------|------------|-------|
| **vLLM** | Production serving | 120-160 req/s | Hours | Industry standard |
| **SGLang** | Agents, RAG | Up to 3.1x vLLM | Hours | RadixAttention |
| **TensorRT-LLM** | Max NVIDIA perf | Highest | 1-2 weeks | Complex setup |
| **llama.cpp** | Edge/local | Varies | Minutes | CPU excellence |
| **Ollama** | Dev/prototyping | Moderate | Minutes | Simplest setup |

### vLLM

The production standard for LLM serving, developed at UC Berkeley.

**Key Features:**
- PagedAttention for memory efficiency
- Continuous batching
- Tensor parallelism
- OpenAI-compatible API
- Wide model support

**Performance Characteristics:**
- 120-160 requests/second typical
- 50-80ms time to first token
- Scales well from 10 to 100+ concurrent users

**Quick Start:**
```bash
pip install vllm

# Start server
python -m vllm.entrypoints.openai.api_server \
    --model meta-llama/Llama-3.1-8B \
    --tensor-parallel-size 2 \
    --quantization fp8
```

**Optimization Flags:**
```python
from vllm import LLM, SamplingParams

llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    tensor_parallel_size=4,
    gpu_memory_utilization=0.95,
    enable_chunked_prefill=True,
    enable_prefix_caching=True,  # Reuse common prefixes
    quantization="fp8",
    kv_cache_dtype="fp8"
)
```

### SGLang

Next-generation framework with RadixAttention for improved KV cache reuse.

**Key Innovation - RadixAttention:**
Keeps user prompts in KV cache for reuse when parts repeat:
- Chat history caching
- Few-shot example reuse
- System prompt sharing

**Performance:**
- Up to 3.1x throughput vs vLLM on 70B models
- Matches or exceeds TensorRT-LLM
- Ideal for multi-turn conversations and agents

**Use Cases:**
- Chatbots with long conversation history
- RAG systems with repeated context
- Agent workflows with tool chains
- Few-shot prompting scenarios

```python
import sglang as sgl

@sgl.function
def multi_turn_chat(s, messages):
    for msg in messages:
        if msg["role"] == "user":
            s += sgl.user(msg["content"])
        else:
            s += sgl.assistant(sgl.gen("response"))
    return s
```

### TensorRT-LLM

NVIDIA's optimized inference library for maximum performance.

**Advantages:**
- Highest raw performance on NVIDIA hardware
- Native FP8/INT8 support
- In-flight batching
- Paged KV cache

**Performance:**
- 4.6x A100 performance on H100
- 10,000 tok/s at 100ms TTFT possible
- 35-50ms TTFT at low concurrency

**Trade-offs:**
- Complex setup (1-2 weeks expert time)
- NVIDIA ecosystem lock-in
- Requires Docker typically
- Best if already using Triton/NeMo

```bash
# Docker-based setup
docker run --gpus all -v ./models:/models \
    nvcr.io/nvidia/tritonserver:24.01-trtllm-python-py3 \
    python build.py --model_dir /models/llama-70b
```

### llama.cpp

Pure C/C++ inference with exceptional portability.

**Strengths:**
- Zero dependencies
- Runs anywhere (server, laptop, phone, RPi)
- Fastest startup time
- GGUF native support
- Active community

**Performance (CPU):**
- Optimized for single-stream efficiency
- Excellent on Apple Silicon
- Reasonable throughput on high-core-count CPUs

```bash
# Build and run
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp && make

# Run inference
./main -m models/llama-3-8b.Q5_K_M.gguf \
    -p "Hello, how are you?" \
    -n 128 \
    --threads 8
```

### Ollama

Simplest local LLM deployment with automatic model management.

**2025-2026 Updates:**
- Flash Attention enabled by default (v0.13.5)
- Vulkan acceleration support
- Improved GPU detection
- 20% faster inference vs GUI alternatives

**Limitations:**
- Single-user focused (4 parallel requests max)
- No advanced batching
- Not suitable for production scale

**Best For:**
- Local development
- Prototyping
- Privacy-first single-user apps
- Quick model testing

```bash
# One-line setup
ollama run llama3.1:70b

# With custom parameters
ollama run llama3.1:70b --num-gpu 2 --ctx-size 8192
```

---

## Speculative Decoding

Speculative decoding accelerates inference by having a small "draft" model propose tokens that a larger "target" model verifies in parallel.

### How It Works

1. **Draft Phase:** Small model generates K candidate tokens quickly
2. **Verify Phase:** Large model verifies all K tokens in single forward pass
3. **Accept/Reject:** Accept matching tokens, reject and regenerate mismatches
4. **Guarantee:** Output is mathematically identical to target model alone

### Performance Gains

| Method | Speedup | Notes |
|--------|---------|-------|
| Basic Speculative | 2-3x | Requires separate draft model |
| EAGLE-3 | 2.5-3x | No separate model needed |
| Apple ReDrafter | 2.8x | RNN-based draft head |
| PEARL | 4.43x vs AR | Adaptive draft length |

### Key Techniques (2025-2026)

**EAGLE-3:**
- Lightweight prediction head attached to target model layers
- No separate draft model required
- Improved acceptance rates
- Optimized for NVIDIA GPUs

**Apple ReDrafter:**
- RNN-based draft model on LLM hidden states
- Dynamic tree attention over beam search
- Knowledge distillation training
- State-of-the-art on Vicuna benchmarks

**PEARL (Parallel Speculative Decoding):**
- Pre-verify: Validates first draft token during drafting
- Post-verify: Generates more tokens during verification
- Adaptive draft length based on acceptance patterns
- 1.5x improvement over vanilla speculative decoding

### Implementation in vLLM

```python
from vllm import LLM, SamplingParams

# With separate draft model
llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    speculative_model="meta-llama/Llama-3.1-8B",
    num_speculative_tokens=5,
    speculative_draft_tensor_parallel_size=1
)

# With ngram-based speculation (no draft model)
llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    speculative_model="[ngram]",
    num_speculative_tokens=5,
    ngram_prompt_lookup_max=4
)
```

### Best Practices

1. **Draft Model Selection:**
   - Latency matters more than capability
   - 7-8B draft models work well for 70B targets
   - Same tokenizer required

2. **When to Use:**
   - Latency-sensitive applications
   - Single-user scenarios
   - Long generation tasks

3. **When to Skip:**
   - High-throughput batch scenarios (batching more efficient)
   - Very short outputs
   - Memory-constrained environments

---

## KV Cache Optimization

The KV (Key-Value) cache stores attention computations to avoid recomputation, but traditionally wastes 60-80% of allocated memory.

### The Problem

- A 70B model with 8K context requires ~20GB cache per request
- Batch of 32 = ~640GB cache memory
- KV cache often exceeds model weights in memory consumption
- Traditional systems achieve only 20-38% memory utilization

### PagedAttention (vLLM)

Revolutionary memory management that reduced waste to under 4%.

**How It Works:**
- Divides KV cache into fixed-size pages (like OS virtual memory)
- Non-contiguous storage with indirection table
- Fine-grained allocation and deallocation
- Enables memory sharing between requests

**Impact:**
- 2-4x throughput improvement
- Equivalent to doubling GPU investment
- Enables larger batch sizes

```python
# PagedAttention is automatic in vLLM
# Key configuration options:
llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    gpu_memory_utilization=0.9,  # Reserve 90% for model + cache
    max_model_len=8192,  # Context length affects cache size
)
```

### FP8 KV Cache

Halves KV cache memory with minimal quality impact.

**Recommendation:** On Hopper GPUs, use FP8 over INT8 for KV cache - lower accuracy impact in most cases.

```python
llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    kv_cache_dtype="fp8"  # vs "auto" (fp16)
)
```

### Advanced Techniques

**LMCache:**
Multi-tier caching system for enterprise workloads:
- GPU → CPU DRAM → Local disk
- 3-10x latency reduction for repeated contexts
- Cross-instance cache sharing

**PagedEviction (2025):**
Block-wise eviction of low-importance cache blocks without modifying CUDA kernels.

**KV Cache Offloading:**
Move cache to CPU memory when GPU is constrained:
- Enables models larger than GPU memory
- Uses NVIDIA unified memory or custom solutions
- Trade latency for capacity

### Memory Planning

**Rule of Thumb:** Reserve 40-60% of GPU memory for KV cache.

| Model Size | Recommended KV Cache Budget | Max Batch @ 4K Context |
|------------|----------------------------|------------------------|
| 7B | 20-30% GPU memory | 64+ |
| 13B | 30-40% GPU memory | 32-48 |
| 70B | 50-60% GPU memory | 8-16 |

---

## Continuous Batching

Continuous batching dynamically manages request batches at the iteration level, dramatically improving GPU utilization.

### Batching Strategies Comparison

| Strategy | Description | Best For |
|----------|-------------|----------|
| **Static** | Fixed batch, wait for all | Offline batch jobs |
| **Dynamic** | Time-window batching | Image generation |
| **Continuous** | Iteration-level scheduling | LLM serving |

### How Continuous Batching Works

1. Requests enter queue as they arrive
2. At each decoding iteration:
   - Completed sequences exit batch immediately
   - New requests fill empty slots
3. No waiting for longest sequence
4. GPU stays maximally utilized

### Performance Impact

- **23x throughput improvement** with vLLM continuous batching
- GPU utilization increases from <40% to ~50%+ with memory-aware scheduling
- Requests return immediately upon completion

### Framework Support

All major frameworks support continuous batching:
- **vLLM:** Native continuous batching
- **SGLang:** Enhanced with RadixAttention
- **TensorRT-LLM:** "In-flight batching"
- **LMDeploy:** "Persistent batching"
- **HuggingFace TGI:** Built-in support

### 2025 Advancements: Memory-Aware Dynamic Batching

Research published in 2025 introduces dynamic batch size adjustment based on:
- Real-time memory monitoring
- SLA constraints
- Latency feedback

**Results:** Up to 28% additional throughput improvement over static continuous batching.

### Implementation Example

```python
# vLLM handles continuous batching automatically
# Key parameters to tune:

from vllm import AsyncLLMEngine, EngineArgs

engine_args = EngineArgs(
    model="meta-llama/Llama-3.1-70B",
    max_num_seqs=256,  # Max concurrent sequences
    max_num_batched_tokens=8192,  # Max tokens per batch
    scheduler_delay_factor=0.0,  # 0 = greedy scheduling
)

engine = AsyncLLMEngine.from_engine_args(engine_args)
```

### Best Practices

1. **Set appropriate max_num_seqs:** Balance memory vs throughput
2. **Monitor queue depth:** Custom metric for HPA scaling
3. **Use prefill chunking:** Prevent long prompts from blocking decode
4. **Enable prefix caching:** Reuse common prompt prefixes

---

## Hardware Considerations

### NVIDIA GPU Comparison (2026)

| GPU | Memory | Bandwidth | FP8 TFLOPS | Best For | Typical Price |
|-----|--------|-----------|------------|----------|---------------|
| A100 | 40/80GB HBM2e | 2 TB/s | N/A | Cost-efficient production | $1.50-2/hr |
| H100 | 80GB HBM3 | 3.35 TB/s | 1979 | Highest performance | $2.85-3.50/hr |
| H200 | 141GB HBM3e | 4.8 TB/s | 1979 | Large models, long context | $4-6/hr |
| B200 | 192GB HBM3e | 8 TB/s | 4500 | Next-gen cutting edge | Limited availability |

### H100 vs A100 Decision Matrix

**Choose H100 when:**
- FP8 precision is beneficial (transformer workloads)
- Maximum throughput required
- Long context support needed (80GB + 3.35TB/s bandwidth)
- Real-time inference at scale

**Choose A100 when:**
- Optimizing for cost
- Legacy model compatibility required
- Mid-sized LLMs (7B-13B)
- Burstable/occasional workloads

### H100 Key Advantages

1. **Transformer Engine:** Automatic FP8/FP16 precision selection
2. **4th Gen Tensor Cores:** 4x performance vs A100 3rd gen
3. **Memory Bandwidth:** 1.6x improvement (3.35 vs 2 TB/s)
4. **Compute:** 3x+ FP16 tensor performance

**Benchmark Results:**
```
H100 vs A100 (TensorRT-LLM):
- 4.6x overall performance
- 2x throughput at constant batch size
- 3x throughput at increased batch size
```

### Price Trends (2025-2026)

H100 pricing has dropped dramatically:
- **2024:** $8/hour typical
- **2025-2026:** $2.85-3.50/hour
- This effectively eliminates A100's previous cost advantage

### Memory Requirements by Model Size

| Model | FP16 | INT8 | INT4 |
|-------|------|------|------|
| 7B | 14GB | 7GB | 4GB |
| 13B | 26GB | 13GB | 7GB |
| 34B | 68GB | 34GB | 17GB |
| 70B | 140GB | 70GB | 35GB |

### Multi-GPU Strategies

**Tensor Parallelism:**
- Split model layers across GPUs
- Reduces per-GPU memory
- Requires high-bandwidth interconnect (NVLink)
- Best for latency-sensitive serving

**Pipeline Parallelism:**
- Split model stages across GPUs
- Better for throughput
- Higher latency
- Works with slower interconnects

```python
# vLLM tensor parallelism
llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    tensor_parallel_size=4,  # Split across 4 GPUs
)
```

---

## Production Deployment Patterns

### Kubernetes-Native Deployment

**llm-d Framework (2025):**
Kubernetes-native distributed inference with:
- Prefill/decode disaggregation
- KV-cache-aware load balancing
- Multi-accelerator support (NVIDIA, AMD, TPU, Intel)
- Traffic-aware autoscaling

**v0.4 Results:**
- 40% reduction in time per output token
- Improved model-as-a-service efficiency

### Architecture Patterns

**1. Disaggregated Serving:**
```
┌─────────────────┐     ┌─────────────────┐
│  Prefill Pods   │────▶│  Decode Pods    │
│  (GPU-bound)    │     │  (Memory-bound) │
└─────────────────┘     └─────────────────┘
```
- Separate prefill (prompt processing) from decode (generation)
- Optimizes GPU utilization for each phase
- Reduces TTFT, improves TPOT consistency

**2. Standard Replicated:**
```
┌─────────────────┐
│   Load Balancer │
└────────┬────────┘
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────┐
│ Pod 1 │ │ Pod 2 │
└───────┘ └───────┘
```
- Simpler architecture
- Good for smaller models
- Standard K8s autoscaling

### Autoscaling Configuration

**Unique LLM Challenges:**
- GPU scheduling complexity
- 30-120 second startup times
- Variable request duration
- Memory intensity

**HPA Configuration:**
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: llm-inference
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: vllm-deployment
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Pods
    pods:
      metric:
        name: gpu_utilization
      target:
        type: AverageValue
        averageValue: "80"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # Prevent thrashing
    scaleUp:
      stabilizationWindowSeconds: 60
```

**Key Metrics for Scaling:**
- GPU utilization
- Inference queue depth
- Memory utilization
- Request latency percentiles

### Cost Optimization

1. **Resource Quotas:** Track GPU usage by namespace/model
2. **Spot Instances:** Use for non-critical inference
3. **Scheduled Shutdowns:** Auto-shutdown dev clusters after hours
4. **Right-sizing:** Match GPU to model requirements

### Observability Stack

Essential monitoring for production:
- **Metrics:** GPU utilization, queue depth, latency percentiles
- **Logs:** Correlation IDs for request tracing
- **Tracing:** Identify bottlenecks (preprocessing, inference, post)
- **Alerts:** Queue backup, latency SLA breaches, OOM

---

## Edge and Mobile Deployment

### The Edge AI Landscape (2026)

Edge LLMs in 2026 represent a paradigm shift, with models under 9B parameters rivaling cloud giants in specific tasks.

### Key Compression Techniques

| Technique | Memory Reduction | Quality Impact |
|-----------|-----------------|----------------|
| 4-bit quantization | 75% | Moderate |
| 2-bit k-means | 90% | Significant |
| 2:4 Sparsity | 50%+ | Minimal |
| Knowledge distillation | N/A | Can improve |
| MoE layer dropping | Variable | Task-dependent |

### Top Edge Models (2026)

1. **Meta-Llama-3.1-8B-Instruct**
2. **GLM-4-9B-0414**
3. **Qwen2.5-VL-7B-Instruct**

These balance performance with 7-9B parameter counts optimized for edge.

### Frameworks for Edge

**NVIDIA TensorRT Edge-LLM:**
- C++ framework for automotive/robotics
- EAGLE-3 speculative decoding
- NVFP4 quantization
- Chunked prefill for memory efficiency

**Meta ExecuTorch:**
- PyTorch models direct to edge devices
- Powers Instagram, WhatsApp, Messenger, Facebook
- No format conversion required

**Cactus SDK:**
- Sub-50ms time-to-first-token on mobile
- Cross-platform (iOS, Android)
- Supports Qwen, Gemma, Llama, DeepSeek, Phi, Mistral
- Y Combinator backed

### Mobile Edge Intelligence (MEI)

Hybrid approach combining:
- Small Language Models (SLMs) on device
- LLMs at edge servers
- Speculative decoding for efficiency

**Benefits:**
- Lower latency than cloud
- Reduced bandwidth costs
- Privacy preservation
- Offline capability

### Practical Edge Performance

```
Llama2-7B on NVIDIA Jetson AGX Orin:
- INT4 quantization
- 7GB memory requirement
- ~4.5 tokens/second

7B model on consumer GPU (6GB+ VRAM):
- 15-25 tokens/second typical
- GGUF Q4_K_M quantization
```

---

## Benchmarks and Performance

### FlashAttention-3 (2025-2026)

The latest attention optimization for Hopper GPUs.

**Key Numbers:**
- **BF16:** 840 TFLOPS (85% utilization)
- **FP8:** 1.3 PFLOPS (1300 TFLOPS)
- **Memory:** Linear in sequence length vs quadratic

**Optimizations:**
1. Asynchronous Tensor Core + TMA overlap
2. Interleaved matmul and softmax
3. Block quantization for FP8

**Memory Savings:**
- 10x at 2K sequence length
- 20x at 4K sequence length
- Enables much longer contexts

### Framework Throughput Comparison

| Framework | Throughput (req/s) | TTFT (ms) | Best Config |
|-----------|-------------------|-----------|-------------|
| TensorRT-LLM | Highest | 35-50 | Low concurrency |
| SGLang | Up to 3.1x vLLM | Varies | High KV reuse |
| vLLM | 120-160 | 50-80 | High concurrency |
| llama.cpp | Lower | Fast | Single user |

### Quantization Quality Benchmarks

**HumanEval (Code Generation):**
```
GGUF Q5_K_M: 54.27% (only 2% below FP16 baseline)
AWQ 4-bit:   ~52%
GPTQ 4-bit:  ~50%
```

**Quality Retention:**
```
AWQ:  95%
GGUF: 92%
GPTQ: 90%
```

### H100 vs A100 Real-World

```
Llama-3.1-70B Inference:
─────────────────────────
H100 (TensorRT-LLM):
- Throughput: 10,000 tok/s possible
- TTFT: ~100ms at scale

A100 (vLLM):
- Throughput: ~2,000-3,000 tok/s
- TTFT: ~200-400ms
```

---

## Practical Recommendations

### Decision Tree: Choosing Your Stack

```
START
  │
  ├─▶ Production at scale?
  │     ├─▶ Yes: High throughput needed?
  │     │     ├─▶ Yes: SGLang or TensorRT-LLM
  │     │     └─▶ No: vLLM (reliable default)
  │     │
  │     └─▶ No: Local/edge deployment?
  │           ├─▶ GPU available: Ollama or llama.cpp
  │           └─▶ CPU only: llama.cpp with GGUF
  │
  └─▶ Development/prototyping: Ollama
```

### Quantization Selection Guide

| Scenario | Recommended | Reason |
|----------|-------------|--------|
| Production GPU (Hopper) | FP8 | Best quality/speed balance |
| Production GPU (Ampere) | AWQ or INT8 | No native FP8 |
| High throughput batch | GPTQ + Marlin | Speed priority |
| Quality-critical | AWQ or FP8 | Best retention |
| Local/laptop | GGUF Q5_K_M | Versatile |
| Mobile/edge | GGUF Q4_K | Memory efficiency |

### Quick Start Configurations

**Production (H100, 70B model):**
```python
from vllm import LLM

llm = LLM(
    model="meta-llama/Llama-3.1-70B",
    tensor_parallel_size=4,
    quantization="fp8",
    kv_cache_dtype="fp8",
    gpu_memory_utilization=0.9,
    enable_prefix_caching=True,
    enable_chunked_prefill=True,
)
```

**Local Development (16GB GPU):**
```bash
ollama run llama3.1:8b-instruct-q5_K_M
```

**Edge Deployment:**
```bash
# llama.cpp
./main -m llama-3.1-8b.Q4_K_M.gguf \
    -c 4096 \
    --threads 8 \
    -ngl 99  # Offload all layers to GPU if available
```

### Common Pitfalls to Avoid

1. **GGUF in vLLM:** GGUF preserves quality but has poor vLLM performance. Use llama.cpp instead.

2. **Ignoring Kernels:** Algorithm is half the story. Marlin kernels make GPTQ 2.5x faster.

3. **Over-allocating Memory:** Leave headroom for KV cache growth.

4. **Static Batching for LLMs:** Always use continuous batching for real-time serving.

5. **Skipping Calibration:** GPTQ quality depends heavily on calibration dataset selection.

### Performance Optimization Checklist

- [ ] Enable FlashAttention (automatic in modern frameworks)
- [ ] Use appropriate quantization (FP8 on Hopper)
- [ ] Configure continuous batching
- [ ] Enable prefix caching if prompts share prefixes
- [ ] Set appropriate gpu_memory_utilization (0.85-0.95)
- [ ] Use tensor parallelism for large models
- [ ] Consider speculative decoding for latency-sensitive apps
- [ ] Monitor and tune max_num_seqs based on workload

---

## Summary

### Key Takeaways for 2026

1. **FP8 is the new default** for Hopper GPUs - near-lossless with 30%+ speed gains

2. **vLLM + PagedAttention** remains the production standard with 2-4x throughput improvements

3. **SGLang leads in throughput** for agent/RAG workloads with RadixAttention

4. **Continuous batching is essential** - up to 23x improvement over static batching

5. **Speculative decoding** delivers 2-3x speedup for latency-sensitive applications

6. **H100 pricing has normalized** ($3-4/hr) making it the default choice over A100

7. **Edge deployment is maturing** with sub-9B models achieving competitive results

### The Optimization Stack (Ranked by Impact)

1. **Batching:** Continuous batching (23x potential)
2. **Memory:** PagedAttention (2-4x)
3. **Precision:** FP8 quantization (30% speed)
4. **Attention:** FlashAttention-3 (1.5-2x)
5. **Decoding:** Speculative (2-3x latency)

---

## References

- [vLLM Documentation](https://docs.vllm.ai/)
- [SGLang GitHub](https://github.com/sgl-project/sglang)
- [TensorRT-LLM](https://nvidia.github.io/TensorRT-LLM/)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [FlashAttention-3 Paper](https://arxiv.org/abs/2407.08608)
- [PagedAttention Paper](https://arxiv.org/abs/2309.06180)
- [llm-d Project](https://github.com/llm-d/llm-d)
