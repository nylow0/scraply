# Universal Project Idea Workflow

## Goal

Create a reusable system for generating strong project ideas for any domain:
software, business, research, math, ecology, competitions, personal systems, content, experiments, etc.

Do not treat this as only a startup/business workflow.

---

## 1. Intake Questions

Ask questions one at a time. Do not dump the whole form at once.

### Required Questions

1. What are we trying to generate ideas for?
2. What is the broad theme or area, and what is your rough description?
3. What would make an idea “good” in this context?
4. What final output do you want?
5. Who or what decides whether this succeeds?
6. Why do you want to do this, and what main reward do you care about?
7. What is the deadline or ideal completion window, and how much time can you spend per week?
8. What skills, tools, resources, people, or data do you already have access to?
9. What do you absolutely not want to do?
10. What decision do we need at the end?

### Optional Questions

11. Do you want safe/practical ideas, weird/high-upside ideas, or a mix?
12. What existing things, problems, or examples should we pay attention to?
13. What should we research before generating ideas?
14. What scoring criteria should matter most?
15. Is there anything else important that the previous questions did not cover?

---

## 2. Project Brief

After intake, create a short project brief with:

- project name
- theme
- short description
- desired output
- success definition
- constraints
- available resources
- avoid list
- research needs
- final decision needed

---

## 3. Research Phase

Use six separate research streams:

1. **Landscape**: topic state, key concepts, constraints, current approaches.
2. **Exemplars**: similar people, projects, products, papers, demos, entries.
3. **Pain and Gaps**: complaints, missing pieces, weak points, unsolved problems.
4. **Resources**: datasets, tools, APIs, libraries, communities, methods.
5. **Analogies**: adjacent fields solving similar-shaped problems.
6. **Evaluation**: rubrics, benchmarks, judging criteria, quality signals.

Each stream should produce a readable report, not raw JSON.

Preferred report format:

- brief summary
- what was researched
- key findings
- useful examples or sources
- opportunities noticed
- weak spots / uncertainty
- suggested next search

Reports should be written as simple semantic HTML when possible.

---

## 4. Publishing Reports

If the plan publisher is available, publish reports using:

```powershell
C:\Business\planning\publish-plan.cmd <path-to-fragment.html>