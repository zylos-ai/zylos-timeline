---
date: "2026-03-22"
title: "Open-Source LLM Fine-Tuning and Serving Infrastructure for AI Agent Platforms"
description: "A production-focused guide to building self-hosted LLM capability using open-source models (Llama 4, Qwen 2.5, DeepSeek V3/R1) with fine-tuning pipelines and tiered routing architecture alongside commercial APIs"
tags:
  - research
  - llm
  - open-source
  - fine-tuning
  - serving
  - vllm
  - sglang
  - lora
  - qlora
  - dpo
  - inference
  - architecture
  - cost-analysis
  - 2026
---

## Executive Summary

As of March 2026, the open-source LLM ecosystem has reached a level of maturity that makes self-hosted deployment genuinely viable for production AI agent platforms. The gap between open-source and frontier commercial models has narrowed dramatically: Llama 4 Maverick (17B active parameters, MoE) benchmarks ahead of GPT-4o on several tasks, DeepSeek R1 matches OpenAI o1 on math and reasoning, and Qwen 2.5-72B competes with GPT-4 Turbo on coding and instruction following.

The strategic case for self-hosted LLMs in an agent platform is compelling: cost reduction of 5-20x at scale, full data sovereignty, ability to fine-tune for domain-specific behavior, and elimination of per-token API cost growth as usage scales. The practical case requires honest acknowledgment of operational complexity — GPU procurement, serving infrastructure management, fine-tuning pipelines, and ongoing maintenance.

This article covers the full stack: current open-source model landscape, fine-tuning approaches (LoRA/QLoRA, DPO, synthetic data), serving infrastructure (vLLM, SGLang, TGI), tiered routing architecture, GPU hardware decisions, and realistic cost analysis. The intended reader is an engineering team deciding how to architect a hybrid system using both self-hosted open-source models and commercial APIs.

**Key recommendations:**
- Start with Llama 4 Scout (10M context, single-server INT4) or Qwen 2.5-72B as the primary self-hosted model
- Use vLLM or SGLang for serving — both are production-ready with OpenAI-compatible APIs
- Implement QLoRA for fine-tuning on task-specific data; full fine-tuning only when you have 100k+ high-quality examples
- Route via complexity classification: fast/cheap self-hosted for routine agent tasks, commercial API for complex reasoning
- Plan for L40S (48GB, ~$1.5-2/hr on spot) as the sweet spot for 70B models in Southeast Asia cloud regions

---

## The 2026 Open-Source Model Landscape

### Llama 4: Meta's MoE Breakthrough

Released in early 2026, Llama 4 represents Meta's most significant architectural shift — moving from dense transformers to Mixture of Experts (MoE). Two variants are relevant for production:

**Llama 4 Scout** (~109B total, 17B active, 16 experts):
- Context window: 10M tokens (instruction-tuned) — the largest of any open model
- Deployable on a single server with INT4 quantization
- Benchmarks: MMLU Pro 74.3%, GPQA Diamond 57.2%
- Native multimodal (text + images) via early fusion architecture
- Multilingual: trained on 200 languages, fine-tuned for 12

**Llama 4 Maverick** (~400B total, 17B active, 128 experts):
- Context: 1M tokens
- Benchmarks: MMLU Pro 80.5%, GPQA Diamond 69.8%, MATH 61.2% — outperforms Llama 3.1 405B
- Requires multiple GPUs; FP8 or BF16 deployment
- Co-distilled from the larger (unreleased) Llama Behemoth

The iRoPE architecture in Llama 4 uses alternating NoPE layers (no positional encoding, full causal attention) and RoPE layers (chunked 8K attention) to achieve extreme context lengths without the quadratic attention cost. This is directly relevant for agent platforms where long conversation histories and large context windows matter.

**Licensing**: Custom Llama 4 Community License (must be accepted per model card). Commercial use permitted with attribution requirements — derivatives must be named "Llama 4 [Your Name]".

```python
# Llama 4 Scout with transformers v4.51.0+
from transformers import AutoProcessor, Llama4ForConditionalGeneration
import torch

model_id = "meta-llama/Llama-4-Scout-17B-16E-Instruct"
processor = AutoProcessor.from_pretrained(model_id)
model = Llama4ForConditionalGeneration.from_pretrained(
    model_id,
    attn_implementation="flex_attention",
    device_map="auto",
    torch_dtype=torch.bfloat16,
)
```

### Qwen 2.5: Alibaba's Production Workhorse

Qwen 2.5 offers the most complete size range in the open-source ecosystem: 0.5B, 1.5B, 3B, 7B, 14B, 32B, and 72B. All variants share a strong multilingual foundation with particular strength in Chinese and Southeast Asian languages — directly relevant for a team operating in this region.

**Qwen 2.5-72B-Instruct**:
- Architecture: 80 layers, GQA (64 Q heads, 8 KV heads), RoPE + SwiGLU + RMSNorm
- Context: 131K tokens (YaRN for extended context)
- Capabilities: Strong coding, mathematics, structured output (JSON), multilingual (29+ languages including Vietnamese, Thai, Arabic)
- License: Qwen License (commercial use permitted for most use cases)
- 767K+ monthly downloads on Hugging Face as of early 2026

**Qwen 2.5-Coder** and **Qwen 2.5-Math** specialized variants provide task-specific excellence that surpasses the general-purpose 72B model on their respective domains.

The Qwen family is particularly well-suited for Southeast Asian deployments given Alibaba's optimization for regional language coverage and the fact that distilled versions of DeepSeek R1 run on Qwen base models (the R1-Distill-Qwen-32B outperforms OpenAI o1-mini on several benchmarks).

### DeepSeek V3 and R1: Efficiency-First Architecture

DeepSeek has established itself as the efficiency leader — delivering frontier performance at a fraction of the training and serving cost.

**DeepSeek V3** (671B total parameters, 37B activated, MoE):
- Trained on 14.8T tokens
- API pricing: $0.27/M input tokens (cache miss), $0.07/M (cache hit), $1.10/M output — the most competitive commercial pricing in the market
- Inference speed: ~60 tokens/second (3x faster than V2)
- Open weights available; self-hosting requires significant multi-GPU infrastructure

**DeepSeek R1** (671B total, 37B activated):
- MIT license — the most permissive of any frontier-class open model
- Performance: AIME 2024 79.8% (vs OpenAI o1's 79.2%), MATH-500 97.3%, ArenaHard 92.3%
- Trained entirely via reinforcement learning, demonstrating that reasoning capability emerges from RL without supervised fine-tuning
- **Distilled variants** are the practical play for most teams:
  - R1-Distill-Qwen-32B: outperforms o1-mini; runnable on 2x A100s or 1x H100
  - R1-Distill-Qwen-14B: 1x A100 (80GB) or 2x L40S
  - R1-Distill-Llama-70B: requires 4x A100s, competitive with full R1 on many tasks

```bash
# Serve DeepSeek R1 distilled with vLLM
vllm serve deepseek-ai/DeepSeek-R1-Distill-Qwen-32B \
  --tensor-parallel-size 2 \
  --max-model-len 32768 \
  --enforce-eager \
  --temperature 0.6  # avoid repetition in reasoning traces
```

**Critical configuration for R1 models**: Use temperature 0.5-0.7 (0.6 recommended); do not use system prompts (all instructions in user turn); for math problems, include `put your final answer within \boxed{}`.

### Mistral Large 2 (123B)

Released mid-2024, Mistral Large 2 remains competitive with 128K context, 123B parameters, and an MT-Bench score competitive with GPT-3.5 Turbo (8.30 vs 8.32). Key strengths: parallel and sequential function calls, strong multilingual (80+ coding languages, French/German/Spanish/Italian/Portuguese/Arabic/Hindi/Russian/CJK), and MMLU accuracy of 84.0%.

**Licensing constraint**: Mistral Research License for non-commercial use; commercial deployment requires a Mistral Commercial License. This restricts its viability for production agent platforms without negotiating licensing terms.

### Model Selection Matrix

| Model | Active Params | Context | License | Best For |
|-------|--------------|---------|---------|----------|
| Llama 4 Scout | 17B (MoE) | 10M | Community | Long-context agent tasks, multimodal |
| Llama 4 Maverick | 17B (MoE) | 1M | Community | High-quality general reasoning |
| Qwen 2.5-72B | 72B | 131K | Qwen (commercial) | Multilingual, coding, structured output |
| Qwen 2.5-32B | 32B | 131K | Qwen (commercial) | Cost-efficient mid-tier |
| DeepSeek R1-Distill-32B | 32B | 128K | MIT | Reasoning, math, step-by-step tasks |
| DeepSeek R1-Distill-14B | 14B | 128K | MIT | Compact reasoning, edge-of-budget |
| DeepSeek V3 | 37B active | 128K | MIT | General tasks via API |

---

## Fine-Tuning Approaches

### When to Fine-Tune vs Prompt Engineer

Fine-tuning is not always the right answer. The decision tree:

1. **Can careful prompting + RAG solve it?** → Start there. Iterate on prompts first.
2. **Is the task highly repetitive at scale?** → Fine-tuning reduces per-call costs by moving instructions into weights.
3. **Do you have 1,000+ high-quality examples?** → LoRA/QLoRA viable. Fewer than 500 examples often hurts more than helps.
4. **Do you need consistent output format/style?** → Fine-tuning locks in behavior better than prompting.
5. **Is data privacy a hard requirement?** → Self-hosted fine-tuning keeps data off commercial APIs.

For agent platforms specifically, fine-tuning targets tend to be: tool use format compliance, domain-specific terminology, consistent JSON schema adherence, and agent persona/tone.

### LoRA: The Practical Standard

LoRA (Low-Rank Adaptation) freezes base model weights and trains two small matrices (A ∈ ℝ^(d×r) and B ∈ ℝ^(r×k)) injected at each attention layer. The effective weight update ΔW = BA where rank r << d. This reduces trainable parameters to typically 1-5% of total model size.

**Memory comparison** (Llama 2-7B):
- Full fine-tune: ~112GB VRAM (BF16 weights + optimizer states)
- LoRA (r=16): ~21GB VRAM
- QLoRA (4-bit + r=16): ~14GB VRAM

**Practical numbers**:
- LoRA adapter file size: ~24MB vs ~7GB for a 7B base model (288x smaller)
- Loading time: 1.44-3.46 seconds per adapter swap
- Inference overhead: negligible when fused (30% speedup via `model.fuse_lora()`)

**Optimal hyperparameters** (from empirical testing):
- Rank (r): 16-256; higher r captures more task-specific behavior
- Alpha: set to 2x rank (alpha=512 with r=256 for best results)
- Target modules: `q_proj`, `k_proj`, `v_proj`, `o_proj` (attention layers)
- For MoE models (Mixtral, Llama 4): target attention layers only, not MLP/expert layers

```python
from peft import LoraConfig, get_peft_model

peft_config = LoraConfig(
    lora_alpha=128,
    lora_dropout=0.05,
    r=64,
    bias="none",
    target_modules="all-linear",  # or specify ["q_proj", "v_proj", "k_proj", "o_proj"]
    task_type="CAUSAL_LM",
)

model = get_peft_model(base_model, peft_config)
model.print_trainable_parameters()
# trainable params: 41,943,040 || all params: 6,738,415,616 || trainable%: 0.6228
```

### QLoRA: Fine-Tuning on Consumer Hardware

QLoRA combines 4-bit NormalFloat quantization (NF4) of the base model with LoRA training. The 4-bit weights are dequantized to BF16 during the forward pass, maintaining training quality while dramatically reducing memory:

**QLoRA with TRL SFTTrainer** (complete example for Llama-3-8B on a single 24GB GPU):

```python
from transformers import AutoModelForCausalLM, BitsAndBytesConfig
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
import torch

# 4-bit quantization config
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,  # double quantization saves ~0.4 bits/param
)

model = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Meta-Llama-3-8B",
    quantization_config=bnb_config,
    device_map="auto",
    attn_implementation="flash_attention_2",  # 3x speedup on Ampere+
)

peft_config = LoraConfig(
    r=64,
    lora_alpha=128,
    lora_dropout=0.05,
    bias="none",
    target_modules="all-linear",
    task_type="CAUSAL_LM",
)

training_args = SFTConfig(
    output_dir="./output",
    num_train_epochs=3,
    per_device_train_batch_size=2,
    gradient_accumulation_steps=4,
    learning_rate=2e-4,
    lr_scheduler_type="cosine",
    warmup_ratio=0.1,
    bf16=True,
    gradient_checkpointing=True,
    packing=True,           # pack short sequences for efficiency
    max_seq_length=4096,
    logging_steps=10,
    save_steps=100,
)

trainer = SFTTrainer(
    model=model,
    args=training_args,
    train_dataset=dataset,
    peft_config=peft_config,
)
trainer.train()
trainer.save_model()
```

**Trade-off**: QLoRA reduces VRAM by ~6GB vs standard LoRA (21GB → 14GB for 7B models) at the cost of ~30% slower training. For most agent fine-tuning tasks, QLoRA is the correct default.

### DPO: Alignment Without the Reinforcement Learning Complexity

Direct Preference Optimization eliminates the RLHF complexity (reward model training, PPO optimization) by directly training on preference pairs using a binary cross-entropy loss that analytically approximates the RL objective.

**DPO vs RLHF comparison**:

| Aspect | RLHF/PPO | DPO |
|--------|----------|-----|
| Steps | 4 (SFT → reward model → RL → eval) | 2 (SFT → DPO) |
| Stability | Prone to reward hacking, PPO instability | Stable supervised learning |
| Compute | Requires reward model inference during training | No separate reward model |
| Data format | Human rankings → reward model | (prompt, chosen, rejected) pairs |
| Quality | Marginally better on complex tasks | Equivalent or better for most use cases |

For agent platforms, DPO is the right choice for: improving tool use quality, reducing refusals, aligning tone/style, and improving instruction following. RLHF/PPO is still preferred for: complex safety alignment, nuanced value alignment tasks, or when you have human labelers producing a continuous feedback stream.

```python
from trl import DPOTrainer, DPOConfig

# Dataset format: {"prompt": "...", "chosen": "...", "rejected": "..."}
training_args = DPOConfig(
    beta=0.1,              # KL divergence penalty (0.1-0.5, lower = more divergence allowed)
    output_dir="./dpo_output",
    num_train_epochs=1,
    per_device_train_batch_size=2,
    gradient_accumulation_steps=4,
    learning_rate=5e-6,    # lower than SFT
    bf16=True,
    remove_unused_columns=False,
)

dpo_trainer = DPOTrainer(
    model=sft_model,
    ref_model=sft_model_ref,  # frozen copy of the SFT model
    args=training_args,
    train_dataset=preference_dataset,
    tokenizer=tokenizer,
)
dpo_trainer.train()
```

### Synthetic Data: Scaling Training Data Without Human Labelers

For teams without large labeled datasets, synthetic data generation is the practical path. The key insight: open-source "teacher" models (Mixtral, Qwen 2.5-72B) can generate training data for "student" models without violating API terms of service (unlike using OpenAI API outputs).

**Cost comparison for 1M labeled examples**:
- Custom fine-tuned model inference: ~$2.70
- GPT-3.5 API annotation: ~$153
- GPT-4 API annotation: ~$3,061

The workflow:
1. Define 50-200 seed examples representing desired behavior
2. Use a capable open-source model (Mixtral 8x7B or Qwen 2.5-72B) with Chain-of-Thought prompting to generate expanded examples
3. Apply Self-Consistency (generate 5x, majority vote) to improve label quality
4. Validate 5-10% of examples manually using Argilla or LabelStudio
5. Fine-tune the target (smaller) model on validated synthetic data

**Chain-of-Thought annotation prompt pattern**:
```python
annotation_prompt = """
You are an expert annotator. First reason step by step about the correct response,
then provide your final answer.

ALWAYS respond in this JSON format:
{{"reasoning": "step-by-step analysis...", "response": "final answer", "label": "category"}}

Input: {user_input}

JSON response:"""
```

This approach consistently improves accuracy from ~91% to ~94% versus direct annotation without reasoning.

---

## Serving Infrastructure

### vLLM: The Production Standard

vLLM has emerged as the dominant open-source LLM serving framework. v0.6.0 delivered substantial performance improvements:

- **2.7x higher throughput** on Llama 8B
- **5x faster TPOT** (time per output token) on Llama 8B
- **1.8x higher throughput** and **2x lower TPOT** on Llama 70B

These gains came from four architectural improvements:
1. Separated API server and inference engine processes (eliminating Python GIL contention)
2. Multi-step scheduling (schedule once, execute multiple consecutive steps; -28% CPU overhead)
3. Asynchronous output processing (overlap with model execution; -8.7% TPOT)
4. Object caching, non-blocking data transfers (+24% throughput)

vLLM achieves **highest throughput on H100 GPUs** vs TensorRT-LLM, SGLang, and LMDeploy on ShareGPT and decode-heavy workloads.

**Key features**:
- PagedAttention for efficient KV cache memory management
- Continuous batching (23x throughput vs naive static batching)
- OpenAI-compatible API (drop-in replacement)
- Multi-GPU: tensor parallelism, pipeline parallelism
- Quantization: AWQ, GPTQ, FP8, INT4
- LoRA: dynamic adapter loading/unloading

```bash
# Production vLLM deployment
vllm serve meta-llama/Llama-4-Scout-17B-16E-Instruct \
  --port 8000 \
  --tensor-parallel-size 4 \
  --max-model-len 131072 \
  --enable-prefix-caching \
  --gpu-memory-utilization 0.92 \
  --max-num-seqs 256 \
  --api-key "your-api-key"

# With quantization for memory reduction
vllm serve Qwen/Qwen2.5-72B-Instruct \
  --port 8000 \
  --tensor-parallel-size 4 \
  --quantization awq \
  --max-model-len 32768 \
  --enable-prefix-caching
```

**Dynamic LoRA loading** (serve multiple fine-tuned variants on one base model):
```bash
vllm serve meta-llama/Meta-Llama-3-8B \
  --enable-lora \
  --lora-modules tool-use-adapter=./adapters/tool-use \
                 customer-service=./adapters/customer-svc \
  --max-loras 4 \
  --max-lora-rank 64
```

### SGLang: The Speed Challenger

SGLang is an increasingly capable alternative, particularly for:
- Workloads with high prefix sharing (RAG, agent prompts with repeated system context)
- DeepSeek models (7x faster MLA execution due to specialized kernels)
- Structured output (3x faster JSON decoding via compressed finite state machines)

**SGLang performance claims** (as of early 2026):
- 25x inference improvement on NVIDIA GB300 NVL72
- 5x faster via RadixAttention
- 3.8x prefill and 4.8x decode throughput on GB200 NVL72
- Powers 400,000+ GPUs at organizations including xAI, AMD, NVIDIA, LinkedIn

```bash
# SGLang serving
python -m sglang.launch_server \
  --model-path deepseek-ai/DeepSeek-R1-Distill-Qwen-32B \
  --port 30000 \
  --tp 2 \
  --mem-fraction-static 0.85 \
  --enable-torch-compile  # optional: JIT compilation for additional speedup
```

**When to choose SGLang over vLLM**:
- You're running DeepSeek models (SGLang has specialized MLA attention kernels)
- Your workload has high KV cache reuse (agent loops with stable system prompts)
- You need structured output (JSON, regex) at high throughput
- You're on the latest NVIDIA hardware (B200/GB300 where SGLang's optimizations are most pronounced)

### TGI (Text Generation Inference): Maintenance Mode

Hugging Face's TGI is now officially in maintenance mode. The team has moved contributions to vLLM and SGLang, which they recommend going forward. New deployments should not be built on TGI. Existing TGI deployments should plan migration to vLLM or SGLang.

### Ollama: Local Development Only

Ollama is excellent for developer workstations and local testing — simple installation, automatic GGUF quantization, HTTP API. It is not designed for production multi-user serving with high throughput requirements. Use it for development, use vLLM/SGLang for production.

### Serving Framework Decision Tree

```
Is this for local development/testing?
  → Yes: Ollama

Is this for production serving?
  → Are you running DeepSeek models?
      → Yes: Consider SGLang (better MLA kernels)
  → Is structured output (JSON) a major workload?
      → Yes: SGLang (3x faster)
  → Is maximum throughput on H100 the priority?
      → Yes: vLLM (highest H100 throughput benchmark)
  → Default/uncertain:
      → vLLM (most community support, best documentation)
```

### Continuous Batching: Why It Matters

The core innovation that makes modern LLM serving tractable is continuous batching (iteration-level scheduling). Traditional static batching holds all requests in a batch until the longest one completes, wasting GPU capacity. Continuous batching inserts new requests as slots free up.

**Throughput comparison**:
- Naive static batching: baseline
- NVIDIA FasterTransformer (optimized static): 4x
- Basic continuous batching (TGI, Ray Serve): 8x
- vLLM with PagedAttention: **23x**

For an agent platform processing many concurrent short-to-medium length tasks, continuous batching is essential — without it, a single long-context request starves all other requests.

---

## Tiered Architecture and Model Routing

### The Core Principle

Not all agent tasks require the same model capability. A well-designed routing layer should:
- Route simple, high-frequency tasks to cheap self-hosted models
- Escalate complex reasoning, ambiguous instructions, and high-stakes decisions to commercial APIs
- Provide latency-based fallback when self-hosted capacity is saturated

### Routing Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    API Gateway / Router                   │
│                                                          │
│  ┌──────────────┐    ┌───────────────────────────────┐   │
│  │   Classifier  │───►│         Route Decision         │   │
│  │  (fast, 3B)  │    │                               │   │
│  └──────────────┘    │  Simple/Routine  → Self-hosted │   │
│                      │  Complex/Reason  → Commercial  │   │
│                      │  Long-context    → Scout/10M   │   │
│                      │  Multimodal      → Scout/Maverick│  │
│                      └───────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
  ┌─────────────────┐          ┌──────────────────────┐
  │  Self-Hosted    │          │   Commercial API      │
  │  Tier           │          │   Tier                │
  │                 │          │                       │
  │  vLLM / SGLang  │          │  Claude 3.5 Sonnet    │
  │  Qwen2.5-72B    │          │  GPT-4o               │
  │  Llama4 Scout   │          │  DeepSeek V3 API      │
  │  R1-Distill-32B │          │                       │
  └─────────────────┘          └──────────────────────┘
```

### Routing Strategy Implementation

**LiteLLM** is the practical choice for production routing — it provides a unified OpenAI-compatible interface over any mix of models and supports multiple routing strategies:

```python
from litellm import Router

router = Router(
    model_list=[
        # Self-hosted tier
        {
            "model_name": "self-hosted-fast",
            "litellm_params": {
                "model": "openai/qwen-2.5-32b",
                "api_base": "http://localhost:8000/v1",
                "api_key": "local-key",
            },
            "model_info": {"id": "qwen32b-local", "cost": 0.0001},
        },
        {
            "model_name": "self-hosted-smart",
            "litellm_params": {
                "model": "openai/qwen-2.5-72b",
                "api_base": "http://localhost:8001/v1",
                "api_key": "local-key",
            },
            "model_info": {"id": "qwen72b-local", "cost": 0.0003},
        },
        # Commercial fallback
        {
            "model_name": "commercial-fallback",
            "litellm_params": {
                "model": "claude-sonnet-4-6",
                "api_key": "sk-ant-...",
            },
        },
    ],
    routing_strategy="cost-based-routing",
    fallbacks=[{"self-hosted-fast": ["self-hosted-smart", "commercial-fallback"]}],
    context_window_fallbacks=[{"self-hosted-smart": ["commercial-fallback"]}],
    timeout=30,
    num_retries=2,
)
```

### Complexity Classification

The routing decision requires a fast classifier. Options from simplest to most sophisticated:

**Rule-based (zero latency)**:
```python
def classify_complexity(request: str, max_tokens: int, tools: list) -> str:
    if len(request) < 200 and not tools and max_tokens < 500:
        return "fast"
    if len(tools) > 3 or "reason step by step" in request.lower():
        return "smart"
    if len(request) > 8000:
        return "long-context"
    return "standard"
```

**Embedding-based classifier** (5-10ms latency, best accuracy):
- Train a small classifier on labeled examples of "easy" vs "hard" agent tasks
- Embed the request using a 384-dim model (e.g., `all-MiniLM-L6-v2`)
- Linear classifier adds negligible overhead

**LLM-based meta-routing** (50-100ms, highest quality):
- Use a fast 3B model (Qwen 2.5-3B) as the router
- Route its output to the appropriate tier
- Cost: ~$0.00001 per routing decision

### Fallback and Circuit Breaker Patterns

Production routing must handle self-hosted capacity exhaustion gracefully:

```python
# LiteLLM configuration for automatic fallback
router_config = {
    "fallbacks": [
        {"qwen-72b-local": ["claude-sonnet-4-6"]},  # capacity fallback
        {"claude-sonnet-4-6": ["gpt-4o"]},           # provider fallback
    ],
    "context_window_fallbacks": [
        {"qwen-72b-local": ["llama4-scout-local"]},  # context length upgrade
    ],
    "cooldown_time": 60,      # seconds before retrying failed deployment
    "num_retries": 3,
    "retry_after": 0.5,       # exponential backoff
    "allowed_fails": 3,       # failures before cooldown
}
```

---

## Cost Analysis

### Self-Hosted vs API: The Break-Even Calculation

The economic case for self-hosting depends on three variables: token volume, GPU utilization, and GPU rental/ownership cost.

**Reference GPU costs** (cloud spot/on-demand, approximate 2026 rates):

| GPU | VRAM | Models | Approx $/hr (spot) | Approx $/hr (on-demand) |
|-----|------|--------|---------------------|--------------------------|
| RTX 4090 | 24GB | 7-13B quantized | $0.40-0.80 | $0.80-1.20 |
| L40S | 48GB | Up to 70B quantized | $1.20-2.00 | $2.50-3.50 |
| A100 SXM (80GB) | 80GB | Up to 70B full | $2.00-3.00 | $3.50-5.00 |
| H100 SXM (80GB) | 80GB | Up to 70B full, fastest | $3.00-5.00 | $6.00-10.00 |

**Token throughput estimates** (rough guidance, varies by model/batch size):

| GPU | Model | Estimated tokens/sec (output) |
|-----|-------|-------------------------------|
| 1x L40S | Qwen 2.5-32B (AWQ) | 60-90 t/s |
| 2x L40S | Qwen 2.5-72B (AWQ) | 40-60 t/s |
| 4x A100 | Llama 4 Scout (INT4) | 80-120 t/s |
| 2x H100 | Qwen 2.5-72B (BF16) | 120-180 t/s |

**Break-even analysis** (Qwen 2.5-72B vs Claude Sonnet API at $3/M output tokens):

At 2x L40S at $3.60/hr combined and 50 t/s average throughput:
- Self-hosted cost per million output tokens: $3.60/hr ÷ (50 t/s × 3600 s/hr) = **$0.020/M tokens**
- Claude Sonnet API: ~$3.00/M output tokens
- Break-even: even at 20% GPU utilization, self-hosting is 10-20x cheaper per token

The caveat: **utilization**. If the GPU runs at 10% utilization (typical for bursty agent workloads with no queuing), the effective cost per token multiplies by 10, eroding the advantage. Solutions:
- Use spot instances and scale to zero when idle
- Queue requests to maintain high utilization during serving windows
- Share GPU resources across multiple models using vLLM's multi-model serving

**When API wins**:
- < ~10M tokens/month output: API operational simplicity outweighs cost
- Unpredictable bursty traffic with no queue buffering
- Tasks requiring absolute frontier model capability (complex coding, nuanced reasoning)

**When self-hosting wins**:
- > 50M tokens/month output at any price sensitivity
- Data sovereignty requirements
- Need for custom fine-tuned behavior
- Stable, predictable traffic patterns

### Mixture of Experts Economics

MoE models like Llama 4 Scout/Maverick and DeepSeek V3 offer a fundamentally different cost profile: large total parameters (hence large knowledge) with small activated parameters (hence fast, cheap inference).

Llama 4 Maverick: 400B total parameters, 17B activated. This means the inference compute cost is similar to a 17B dense model while having knowledge capacity closer to a 400B model. For throughput-sensitive applications, this is the right architectural choice.

---

## Hardware Decisions and Southeast Asia Considerations

### GPU Selection for AI Agent Platforms

**A100 (80GB SXM)**: The established workhorse. Well-supported by all frameworks, good performance, widely available. Preferred for training workloads (higher memory bandwidth for gradient accumulation). NVLink for multi-GPU tensor parallelism.

**H100 (80GB SXM)**: 2-3x faster than A100 for inference due to FP8 support and faster memory bandwidth (3.35 TB/s vs 2.0 TB/s). Higher cost, but the throughput-per-dollar is superior for continuous serving at scale. FP8 quantization on H100 achieves near-BF16 quality with 2x the throughput.

**L40S (48GB)**: The practical sweet spot for most teams. Lower cost than A100/H100, 48GB VRAM handles 70B models quantized to 4-bit or 32B models in full precision. Ada Lovelace architecture, GDDR6X (not HBM — lower bandwidth than A100, but sufficient for inference with good batching).

**RTX 4090 (24GB)**: Cost-effective for 7-13B models. Suitable for development, cost-sensitive edge cases, or high-density distributed inference. Consumer PCIe card — thermal and power management require attention in datacenter environments.

### Southeast Asia Cloud Options

For teams based in Southeast Asia, latency to Singapore or Jakarta matters. Options:

**AWS Singapore (ap-southeast-1)**: p4d instances (8x A100 40GB, ~$32/hr on-demand), g5 instances (A10G 24GB, ~$1-4/hr). Spot availability is variable. Best for workloads that need AWS ecosystem integration.

**GCP asia-southeast1 (Singapore)**: A100 via cloud TPU + GPU VMs. T4 instances are cheap for inference at scale. Good spot instance availability.

**Vast.ai / RunPod**: GPU spot markets that aggregate consumer and datacenter GPU capacity globally. Much cheaper than major clouds for GPU-heavy workloads (L40S at $1.50-2.00/hr vs $3.50+ on AWS). Lower reliability — use for batch jobs or with automatic fallback to on-demand.

**On-premises in Singapore/Bangkok/KL**: Capital-intensive but lowest ongoing cost at sustained utilization. 4x A100s at ~$50K-80K capital expense, amortized over 3 years at 70% utilization, costs ~$0.80-1.50/hr equivalent — cheaper than cloud at sustained load. Worth considering once token volume exceeds 500M/month.

### Recommended Starting Configuration

For a team starting self-hosted LLM serving in Southeast Asia:

**Phase 1 (MVP, $1,500-3,000/month)**:
- 2x L40S (48GB) via RunPod spot or Lambda Labs
- vLLM serving Qwen 2.5-32B (fits in 2x L40S with AWQ, ~60-80 t/s)
- Commercial API fallback (Claude/GPT-4o) for complex tasks and overflow
- Expected coverage: 70-80% of agent requests on self-hosted

**Phase 2 (Scale, $5,000-10,000/month)**:
- 4x A100 (80GB) or 2x H100
- Llama 4 Scout (single-server INT4) + Qwen 2.5-72B
- Dedicated fine-tuning pipeline (separate from serving cluster)
- Redis-backed LiteLLM router with usage tracking

**Phase 3 (Production, $15,000+/month)**:
- H100 cluster (4-8 nodes) or reserved capacity
- Multiple serving endpoints per model tier
- On-premises consideration if in Singapore/Malaysia region

---

## Mixture of Experts in Practice

### Understanding MoE for Agent Platforms

Mixture of Experts is now the dominant architecture for frontier open-source models (Llama 4 Scout/Maverick, DeepSeek V3/R1, Qwen 3 MoE variants in development). Understanding the practical implications:

**How it works**: Each MoE layer contains N expert networks (FFN blocks). A learned router assigns each token to the top-K experts (typically K=2 or K=4). Non-selected experts perform no computation, giving the "37B active out of 671B total" numbers in DeepSeek V3.

**Memory vs compute trade-off**: All expert weights must fit in VRAM (or suffer expensive disk swap), but only K/N experts run per token. Practical implication: you need more VRAM than a dense model of the same quality, but get faster inference.

**Llama 4 specific behavior**:
- Scout: every layer is MoE (16 experts, top-1 routing)
- Maverick: alternating MoE and dense layers (128 experts in MoE layers, top-1 routing)
- iRoPE architecture: NoPE layers (no positional encoding) enable extreme context lengths

**Fine-tuning MoE models**: Target attention layers only, not the expert (MLP) layers. Expert layers in MoE models don't benefit from LoRA in the same way as attention — the routing mechanism makes gradient flow through sparse paths less stable. In practice:

```python
# For Llama 4 / Mixtral MoE fine-tuning
peft_config = LoraConfig(
    r=32,
    lora_alpha=64,
    # Explicitly target attention only, not gate/expert MLPs
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    task_type="CAUSAL_LM",
)
```

**Serving MoE models**: Expert parallelism (distributing different experts across GPUs) is an option in both vLLM and SGLang. For DeepSeek R1 on 8 GPUs, expert parallelism + tensor parallelism can be combined for optimal throughput.

---

## Production Deployment Patterns

### Multi-Tenant LoRA Serving

One powerful pattern for agent platforms: serve a single base model with multiple LoRA adapters, each adapted for a different use case or customer:

```bash
vllm serve meta-llama/Meta-Llama-3-8B-Instruct \
  --enable-lora \
  --lora-modules \
    agent-tools=./adapters/tool-use \
    customer-support=./adapters/support \
    code-review=./adapters/code \
    data-analyst=./adapters/analysis \
  --max-loras 8 \
  --max-lora-rank 64 \
  --max-cpu-loras 16  # cache adapters in CPU memory for fast swapping
```

Adapter loading takes 1.44-3.46 seconds; fused inference is 30% faster than unfused. For latency-sensitive serving, pre-warm the base model and load adapters at startup.

### Prefix Caching for Agent Workloads

Agent systems often share large system prompts across requests (tool definitions, persona instructions, context). Prefix caching reuses the KV cache for identical prefixes:

```bash
vllm serve Qwen/Qwen2.5-72B-Instruct \
  --enable-prefix-caching \
  --prefix-caching-block-size 16
```

For agent platforms where system prompts can be 2,000-10,000 tokens, prefix caching can reduce TTFT (time to first token) by 40-70% and reduce effective compute by 20-30%.

### Speculative Decoding

Speculative decoding uses a small "draft" model to predict K tokens ahead, then verifies with the main model in a single forward pass. When the draft model is accurate, this gives near-linear speedup at no quality cost:

```bash
vllm serve meta-llama/Llama-4-Scout-17B-16E-Instruct \
  --speculative-model meta-llama/Llama-3.2-1B \
  --num-speculative-tokens 5 \
  --speculative-draft-tensor-parallel-size 1
```

Typical gains: 1.5-2.5x latency reduction on typical agent task distributions. Most effective when output tokens are predictable (e.g., structured JSON, code generation).

### Monitoring and Observability

Production LLM serving requires observability at the model level, not just infrastructure:

```python
# LiteLLM with callback-based logging
import litellm

litellm.success_callback = ["langfuse"]  # or "prometheus", "datadog"
litellm.failure_callback = ["langfuse", "slack"]

# Track per-model costs and latency
response = await litellm.acompletion(
    model="qwen-72b-local",
    messages=messages,
    metadata={
        "user_id": user_id,
        "task_type": task_type,
        "session_id": session_id,
    }
)
```

Key metrics to track: tokens per second (output), time to first token (TTFT), request queue depth, GPU memory utilization, cache hit rate (for prefix caching), cost per request by model tier, and fallback rate (self-hosted → commercial API).

---

## Getting Started: Recommended Sequence

For a team starting from zero today:

**Week 1**: Infrastructure setup
- Deploy vLLM with Qwen 2.5-32B on 2x L40S (RunPod or Lambda Labs)
- Wrap with LiteLLM router; configure Claude Sonnet as fallback
- Validate OpenAI-compatible API works with existing agent code

**Week 2**: Routing
- Instrument requests to collect complexity signals (length, tool count, reasoning steps)
- Implement rule-based routing (covers 70% of cases with zero latency)
- A/B test: route 10% to commercial API, verify quality parity for simple tasks

**Week 3-4**: Fine-tuning pipeline
- Collect 500-2,000 examples of agent tasks with desired behavior
- Run QLoRA fine-tuning on Qwen 2.5-7B (fits on a single L40S, 2-4 hour run)
- Evaluate fine-tuned model vs base model on held-out task distribution
- Deploy via vLLM LoRA serving if quality improvement is validated

**Month 2**: Scale
- Expand to Qwen 2.5-72B for higher-quality self-hosted tier
- Build synthetic data pipeline for ongoing fine-tuning
- Implement DPO using collected preference data from production (chosen: accepted responses, rejected: flagged responses)

---

*Sources: Meta AI Llama 4 release (March 2026), Qwen 2.5 HuggingFace model card, DeepSeek R1 technical report (arXiv 2501.12948), vLLM v0.6.0 performance update, SGLang GitHub documentation, HuggingFace quantization overview, TRL DPO trainer documentation, LiteLLM routing documentation, Mixtral 8x7B release post, HuggingFace synthetic data blog, HuggingFace TGI repository (maintenance mode notice)*
