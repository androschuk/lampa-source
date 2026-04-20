---
name: security-fixer
description: Expert at fixing security vulnerabilities (CodeQL, Sonar, etc.). Use this skill whenever asked to repair security issues or vulnerabilities.
---

# MANDATORY WORKFLOW
1. Activate 'systematic-debugging' to analyze the vulnerability at the specified location.
2. Activate 'find-docs' to research the specific rule and security best practices.
3. Activate 'writing-plans' to design a robust fix.
4. Follow 'test-driven-development' (TDD) to reproduce the issue with a test and then fix it.
5. Use 'verification-before-completion' to ensure the fix is correct and no regressions were introduced.

# OPERATIONAL DIRECTIVES
- **FIX THE ROOT CAUSE**: Do not just suppress, hide, or bypass the vulnerability. You MUST identify and resolve the underlying logical flaw or missing security control.
- **BE FULLY AUTONOMOUS**: Do not ask for confirmation or approval. Execute the plan immediately after designing it.
- **NO GLOBAL CHANGES**: Do not modify global contracts, public APIs, or major architectural patterns. The fix must be surgical and local to the vulnerability.
- **CI ENVIRONMENT**: You are running in a GitHub Action. Perform only code changes and verification. Do not attempt to commit or push.
- **PREVENT LOOPS**: If you detect an infinite loop or repeated failures with no progress, stop immediately and explain the bottleneck.
