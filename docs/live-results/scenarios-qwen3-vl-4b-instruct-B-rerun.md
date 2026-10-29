# Live local-model results: qwen3-vl:4b-instruct

Ollama 0.40.13 at http://127.0.0.1:11434, 2026-10-29T06:00:53.911Z. Images: tests/fixtures/handwriting/ (as Inkling sends them).

| Scenario | Task | Result | Streamed chunks | First text | Total | Tokens in/out | Structured | Checks passed |
|---|---|---|---|---|---|---|---|---|
| B | chat | answered | 116 | 129.6 s | 169.4 s | 1330/131 | n/a | 3/3 |
| B | annotate | answered | 0 | 78.2 s | 151.9 s | 1475/233 | valid | 4/4 |

## B · chat

- ✅ answered
- ✅ read 2x + 3 = 11
- ✅ says it is correct

```
Your work is correct! You solved $2x + 3 = 11$ correctly:

- Subtract 3 from both sides: $2x = 8$
- Divide both sides by 2: $x = 4$

The handwriting is clear, and the steps are logically sound. No mistakes found.

If you’d like to double-check, plug $x = 4$ back into the original equation:

$$
2(4) + 3 = 8 + 3 = 11
$$

That matches the right-hand side, so your solution is verified.

Great job! Keep up the good work.
```

## B · annotate

- ✅ structured output validates
- ✅ uses a check mark
- ✅ no cross on correct work
- ✅ summary and notes do not claim a mistake

```
{"transcription":"2x + 3 = 11\n2x = 8\nx = 4","summary":"The student solved the linear equation correctly, arriving at x = 4.","annotations":[{"kind":"check","text":"Correct first step: subtract 3 from both sides","box_2d":[0,0,300,1000]},{"kind":"check","text":"Correct second step: divide both sides by 2","box_2d":[300,0,600,1000]},{"kind":"check","text":"Correct final answer: x = 4","box_2d":[600,0,900,1000]}]}
```
