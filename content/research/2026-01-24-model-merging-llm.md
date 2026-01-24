---
date: "2026-01-24"
time: "22:50"
title: "Model Merging for Large Language Models 2026"
description: "Comprehensive analysis of model merging techniques including SLERP, TIES, DARE, and evolutionary optimization - creating powerful models without training costs"
tags:
  - research
  - llm
  - model-merging
  - frankenmerge
  - optimization
  - cost-efficiency
---

## Executive Summary

Model merging has emerged as a transformative technique in 2026 for combining multiple specialized LLMs into powerful unified models without expensive retraining. By performing arithmetic operations on model weights, practitioners can create custom models that combine the strengths of different fine-tuned models while requiring minimal computational resources - merges can run entirely on CPU or with as little as 8GB VRAM. Key techniques like SLERP, TIES, and DARE enable different merging strategies, while evolutionary optimization automates the discovery of optimal merging recipes. This approach has produced many state-of-the-art models on benchmarks, fundamentally changing how organizations build specialized AI systems.

## What is Model Merging?

Model merging is a technique that combines two or more LLMs into a single model by blending their weights through arithmetic operations. Unlike ensemble methods that run multiple models in parallel, or multi-task learning that requires joint training on all tasks, model merging creates a single unified model through parameter-space operations.

### Core Benefits

**Cost Efficiency**: Model merging is one of the most efficient ways to create custom LLMs without GPU overhead. It requires no collection of raw training data and avoids expensive computation costs associated with training from scratch.

**Resource Accessibility**: Using an out-of-core approach, merges can be performed in resource-constrained situations - running entirely on CPU or accelerated with as little as 8GB of VRAM. This democratizes advanced model development.

**Waste Reduction**: Model merging increases resource utilization by combining successful models and reducing experimentation waste by repurposing "failed experiments" into valuable components.

**Speed**: Creating merged models is 5-100× faster than multi-task fine-tuning while often matching or exceeding the performance of jointly trained models.

## Task Arithmetic and Task Vectors

Task arithmetic is the foundational concept behind many merging techniques. A **task vector** is calculated by subtracting the weights of a pretrained model from the weights of the same model fine-tuned for a specific task:

```
task_vector = fine_tuned_weights - pretrained_weights
```

This vector represents a direction in weight space where moving enhances performance on that specific task. Task vectors can be combined through arithmetic operations:

- **Addition**: Combine multiple task vectors to create multi-task models
- **Negation**: Remove unwanted behaviors
- **Scaling**: Control the strength of task-specific knowledge

To create a multi-task model, you sum task vectors and add them back to the pretrained model:

```
multi_task_model = pretrained + (task_vector_1 + task_vector_2 + ...)
```

The key advantage over traditional multi-task learning is efficiency - no joint training required, just arithmetic operations in weight space.

## Core Merging Techniques

### SLERP (Spherical Linear Interpolation)

SLERP smoothly interpolates between two model parameter vectors in a spherical manner, preserving the unique characteristics of each model. It's the preferred method for complex model merging tasks due to its ability to maintain model quality during the transition.

**Characteristics**:
- Smooth transitions between parameters
- Preserves model characteristics better than linear interpolation
- Limited to pairwise combinations (merging two models at once)
- Popular probability: P(SLERP) = 0.4 in automated merging systems

**Best for**: High-quality merges of two models where preserving both models' strengths is critical.

### TIES-Merging (TrIm, Elect Sign, Merge)

TIES-Merging addresses the challenge of efficiently merging multiple task-specific models into a single multitask model by resolving parameter interference.

**Three-step process**:

1. **Trim**: Identify and eliminate redundant parameters by focusing on changes made during fine-tuning. Keep only the top-k% most significant changes and discard the rest.

2. **Elect Sign**: When different models suggest opposing adjustments to the same parameter, create a unified sign vector representing the most dominant direction of change across all models.

3. **Merge**: Combine the trimmed, sign-elected parameters into the final merged model.

**Advantages**:
- Can merge multiple models simultaneously (unlike SLERP)
- Reduces parameter interference through trimming
- Resolves conflicting parameter updates systematically

**Best for**: Merging 3+ task-specific models where parameter conflicts are expected.

### DARE (Drop And REscale)

DARE is not a merging technique itself but a powerful plugin for existing methods. It works by:

1. **Drop**: Randomly drop delta parameters (task vector components) with probability p
2. **REscale**: Rescale remaining parameters by 1/(1-p) to approximate original embeddings

**Remarkable finding**: DARE remains effective even when dropping 90-99% of task vector weights, dramatically reducing the parameter space while maintaining performance.

**Implementation flavors**:
- **dare_linear**: DARE without additional steps
- **dare_ties**: DARE combined with TIES sign election step

**Best for**: Reducing parameter interference and improving merging efficiency, especially when combined with Task Arithmetic or TIES-Merging.

### Passthrough (Layer Stacking)

Passthrough merging concatenates layers from different LLMs sequentially, creating "frankenmerges" or "Frankenstein models."

**Characteristics**:
- Can produce models with exotic parameter counts (e.g., 9B from two 7B models)
- Operates through model surgery and layer stacking
- Popular among hackers for experimentation
- Cheap, dirty, requires trial and error

**Best for**: Experimental model architectures and discovering novel layer combinations.

## Evolutionary Optimization

Manual model merging requires extensive experimentation with hyperparameters and techniques. Evolutionary optimization automates this process.

### How It Works

Evolutionary algorithms automatically discover effective combinations of diverse open-source models by:

1. **Population initialization**: Start with random merging configurations
2. **Fitness evaluation**: Test merged models on target benchmarks
3. **Selection**: Keep best-performing configurations
4. **Mutation and crossover**: Create new configurations by modifying and combining successful ones
5. **Iteration**: Repeat until convergence

### Search Spaces

**Parameter Space (PS) Merging**:
- Enhances TIES-Merging with DARE
- Uses evolutionary algorithms to optimize hyperparameters during merging
- Example: 64-dimensional continuous layerwise weights space

**Data Flow Space (DFS) Merging**:
- Preserves original weights of each layer
- Optimizes the inference path tokens follow through the network
- Example: 32 categorical + 63 continuous dimensions

### Recent Advances

**Nature Machine Intelligence (January 2025)**: Akiba et al. developed an evolutionary approach that creates powerful hybrid models without extensive training, producing models with enhanced mathematical and visual capabilities that outperform larger models.

**Multi-stage Evolutionary Model Merging (MEM-MCL, 2026)**: Enhances sentiment analysis by creating expert models through instruction tuning, then merging with evolutionary algorithms optimized through curriculum learning based on task difficulty.

**MERGE³**: Efficient framework that makes evolutionary merging feasible on a single GPU by reducing fitness computation costs 50× while retaining performance.

**Mergenetic**: Open-source library enabling easy composition of merging methods and evolutionary algorithms with lightweight fitness estimators to reduce evaluation costs.

## MergeKit: The Standard Toolkit

MergeKit is the de facto open-source library for model merging, maintained by Arcee AI. It has facilitated the merging of thousands of models and contributed to world-class open-source checkpoints.

### Key Features

**Hardware Flexibility**: Out-of-core approach allows merges on any hardware, from CPU-only to GPU-accelerated setups.

**Multiple Methods**: Supports SLERP, TIES, DARE, Task Arithmetic, Passthrough, and hybrid approaches.

**Specialized Tools**: mergekit-tokensurgeon transplants tokenizers between models, useful for:
- Creating draft models for speculative decoding
- Cross-tokenizer knowledge distillation
- Vocabulary alignment

### Installation and Usage

```bash
pip install mergekit
```

Basic merge configuration (YAML):

```yaml
models:
  - model: model_1
    parameters:
      weight: 0.5
  - model: model_2
    parameters:
      weight: 0.5
merge_method: slerp
base_model: base_model
parameters:
  t: 0.5
dtype: float16
```

## Production Use Cases

### 1. Code Generation

Merging code-generating LLMs creates superior mini-developer assistants by combining models that excel at different programming languages or paradigms.

### 2. Domain-Specific Models

Organizations create highly customized models for specific industries (legal, medical, financial) by merging general models with domain-fine-tuned variants.

### 3. Multi-Capability Models

Combine models excelling in different areas - one strong in math, another in creative writing, a third in reasoning - into a single versatile model.

### 4. Rapid Prototyping

Test model combinations quickly without committing resources to full training pipelines. Many state-of-the-art models on the Open LLM Leaderboard originated from merging experiments.

### 5. Speculative Decoding

Use mergekit-tokensurgeon to create draft models with aligned vocabularies for faster inference through speculative decoding.

## Performance and Benchmarks

### Benchmark Frameworks

**SMM-Bench (September 2025)**: Introduces formal continuous and mixed search spaces for hyperparameter tuning with:
- 64-dimensional continuous layerwise weights Parameter Space
- Data-Flow Space with 32 categorical + 63 continuous dimensions

**MLLM-Merging Benchmark (May 2025)**: Combines vision, audio, and video modalities into a single LLM using both LoRA and full-tuning experts. Merged models match or exceed multi-task fine-tuning performance while being 5-100× faster to create.

**GNNMerge (March 2025)**: First task-agnostic graph model merging benchmark with analytical closed-form solutions for embedding alignment, yielding up to +24% accuracy improvement.

### Key Metrics

- **Multi-task accuracy**: Performance across all target tasks
- **Normalized performance**: Relative to per-task finetuning
- **Knowledge retention**: Measuring catastrophic forgetting
- **Pareto efficiency**: Optimal trade-offs between tasks
- **Runtime efficiency**: Time and resources required

### Success Stories

- **MythoMax, Toppy, Goliath**: Popular merged models in the community
- **Automerger results**: Random sampling + SLERP/DARE-TIES produces competitive models
- Many top Open LLM Leaderboard entries originated from merging

## Challenges and Limitations

### Performance Degradation

As the number of tasks increases, merged models often underperform compared to independent expert models. Maintaining consistent performance across diverse tasks without extensive task-specific tuning remains difficult.

### Parameter Interference

Existing merging methods often ignore interference between parameters of different models, resulting in large performance drops. Two major sources:

1. **Redundant parameter values**: Multiple models suggesting similar but not identical changes
2. **Sign disagreement**: Models proposing opposing directions for parameter updates

### Task and Domain Conflicts

Merging models trained on different tasks or domains can result in knowledge from one model interfering with another, particularly in multi-task learning and continual learning scenarios.

### Architectural Constraints

State-of-the-art methods primarily work with homogeneous architectures. Merging models of different sizes or bases (e.g., Mistral 3B + Llama 7B) remains experimental and unproven.

Current MoE merging methods rely on simple unweighted averaging that doesn't address parameter interference and requires extensive fine-tuning.

### Theoretical Gaps

The lack of comprehensive theoretical frameworks limits the ability to predict and guarantee performance. There's no unified framework for classification and comparative analysis, leading to inconsistent terminologies and categorizations.

### Manual Experimentation Burden

Until recently, model merging required highly manual testing of different configurations and hyperparameters. Evolutionary optimization addresses this, but discovering effective recipes still requires expertise.

### Privacy and Data Constraints

Cross-domain merging faces limitations around overlapping users/items across domains and unrealistic assumptions that ignore privacy constraints.

## Future Directions

### Expanding Architectural Support

Research into merging heterogeneous architectures - different model families, sizes, and training approaches - will unlock more creative combinations.

### Theoretical Foundations

Development of comprehensive theoretical frameworks will enable performance prediction and guaranteed outcomes, moving from empirical trial-and-error to principled design.

### Automated Discovery

Continued advancement in evolutionary optimization and meta-learning will make optimal merging accessible to non-experts through fully automated recipe discovery.

### Multi-Modal Integration

Extending merging techniques beyond language models to vision, audio, video, and multi-modal systems (as demonstrated by MLLM-Merging Benchmark).

### Production Tooling

Better observability, debugging, and monitoring tools for merged models will improve production adoption and reliability.

### Efficiency Improvements

Techniques like MERGE³ demonstrate 50× cost reductions are possible. Further optimization will make sophisticated merging accessible on edge devices and consumer hardware.

## Practical Recommendations

**Start Simple**: Begin with SLERP for two-model merges or basic Task Arithmetic before advancing to complex techniques.

**Use MergeKit**: Leverage the mature, well-documented mergekit library rather than implementing from scratch.

**Benchmark Systematically**: Test merged models on relevant benchmarks before production deployment. Performance can vary significantly.

**Consider Evolutionary Optimization**: For critical applications, invest in automated search rather than manual hyperparameter tuning.

**Plan for Interference**: Expect parameter conflicts when merging 3+ models. Use TIES or DARE to mitigate.

**Monitor Task Balance**: Check that the merged model doesn't catastrophically forget some tasks while excelling at others.

**Experiment Cheaply**: Model merging's low resource requirements make it ideal for rapid experimentation. Take advantage of this to explore many combinations.

**Preserve Base Model**: Always keep the original pretrained model and task-specific models for potential re-merging with different parameters.

## Conclusion

Model merging represents a paradigm shift in how we build specialized LLMs. By enabling the combination of multiple fine-tuned models through lightweight arithmetic operations, it democratizes advanced model development and dramatically reduces costs. Techniques like SLERP, TIES, and DARE provide robust methods for different scenarios, while evolutionary optimization automates the discovery of optimal recipes. As theoretical understanding deepens and tooling matures, model merging is positioned to become a cornerstone of performant LLM development in production environments.

The ability to create state-of-the-art models on consumer hardware, repurpose "failed" experiments, and rapidly prototype multi-capability systems makes model merging an essential technique for any organization working with LLMs in 2026.

---

**Sources:**
- [An Introduction to Model Merging for LLMs | NVIDIA Technical Blog](https://developer.nvidia.com/blog/an-introduction-to-model-merging-for-llms/)
- [Merge Large Language Models with mergekit](https://huggingface.co/blog/mlabonne/merge-models)
- [A brief analysis of automerger data, feat. SLERP and DARE-TIES LLM merging](https://huggingface.co/blog/kgourgou/a-first-look-at-automerger-data)
- [Evolutionary optimization of model merging recipes | Nature Machine Intelligence](https://www.nature.com/articles/s42256-024-00975-8)
- [GitHub - arcee-ai/mergekit: Tools for merging pretrained large language models](https://github.com/arcee-ai/mergekit)
- [Arcee's MergeKit: A Toolkit for Merging Large Language Models](https://arxiv.org/abs/2403.13257)
- [Evolutionary Optimization of Model Merging Recipes](https://arxiv.org/abs/2403.13187)
- [Evolving New Foundation Models | Sakana AI](https://sakana.ai/evolutionary-model-merge/)
- [ATM: Improving Model Merging by Alternating Tuning and Merging](https://arxiv.org/html/2411.03055)
- [TIES-Merging: Resolving Interference When Merging Models](https://openreview.net/forum?id=xtaX3WyCj1)
- [From Task-Specific Models to Unified Systems: A Review of Model Merging Approaches](https://arxiv.org/html/2503.08998v1)
- [What is Model Merging? Techniques & Challenges](https://www.deepchecks.com/glossary/model-merging/)
