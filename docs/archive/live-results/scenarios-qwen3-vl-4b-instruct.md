# Live local-model results: qwen3-vl:4b-instruct

Ollama 0.40.13 at http://127.0.0.1:11434, 2026-10-29T05:33:15.682Z. Images: tests/fixtures/handwriting/ (as Inkling sends them).

| Scenario | Task | Result | Streamed chunks | First text | Total | Tokens in/out | Structured | Checks passed |
|---|---|---|---|---|---|---|---|---|
| A | chat | answered | 238 | 119.9 s | 218.0 s | 1315/251 | n/a | 5/5 |
| A | annotate | answered | 0 | 123.5 s | 235.5 s | 1460/268 | valid | 8/9 |
| A+explanation | annotate | answered | 0 | 18.2 s | 124.8 s | 1724/241 | valid | 9/9 |
| B | chat | error: server: Ollama's model stopped while answering, usually because the computer ran out of memory. Close other apps and try again, or choose a smaller model (qwen3-vl:2b-instruct) in AI settings. (an error was encountered while running the model: unexpected EOF) | 0 | – | 55.4 s | –/– | n/a | 0/3 |
| B | annotate | answered | 0 | 143.2 s | 242.5 s | 1475/234 | valid | 4/4 |
| C | chat | answered | 162 | 123.1 s | 187.1 s | 1341/163 | n/a | 5/5 |
| D | chat | answered | 150 | 6.8 s | 51.2 s | 354/157 | n/a | 3/3 |
| E | chat | answered | 235 | 5.8 s | 79.7 s | 344/261 | n/a | 3/3 |
| P | practice | error: server: Ollama's model stopped while answering, usually because the computer ran out of memory. Close other apps and try again, or choose a smaller model (qwen3-vl:2b-instruct) in AI settings. (model runner has unexpectedly stopped, this may be due to resource limitations or an internal error, check ollama server logs for details) | 0 | – | 0.8 s | –/– | INVALID | 0/1 |

## A · chat

- ✅ answered
- ✅ streamed in several chunks
- ✅ read the factorisation
- ✅ gives the roots −2 and −3
- ✅ says x = 2, 3 is wrong

```
You wrote $x = 2, 3$ at the bottom — that’s incorrect.

The error is in the sign: you set each factor equal to zero and solved for $x$, but then wrote the *solutions* as $x = 2, 3$. However, from $(x+2)(x+3) = 0$, setting each factor to zero gives:
- $x + 2 = 0 \Rightarrow x = -2$
- $x + 3 = 0 \Rightarrow x = -3$

So the solutions are $x = -2$ and $x = -3$, not $2$ and $3$.

You likely wrote the signs backwards — perhaps you misread the factors or confused the signs when solving.

✅ **Fix**: Change $x = 2, 3$ to $x = -2, -3$.

Also, note: your factoring $(x+2)(x+3) = 0$ is correct, so the work before that is fine. The mistake is only in the final answer.

You’re close — just flip the signs!

Let me know if you want to double-check the factoring or solve it another way.
```

## A · annotate

- ✅ structured output validates
- ✅ transcribed line 1
- ✅ transcribed line 2
- ✅ transcribed line 3
- ✅ marks a mistake
- ✅ the mistake mark is on the last line
- ✅ correction gives −2 and −3
- ❌ summary says there is a mistake — The student factored correctly but wrote the solutions as 2 and 3, which are the negatives of the factors.
- ✅ marks become valid canvas commands

```
{"transcription":"x²+5x+6=0\n(x+2)(x+3)=0\nx=2, 3","summary":"The student factored correctly but wrote the solutions as 2 and 3, which are the negatives of the factors.","annotations":[{"kind":"cross","text":"Solutions are -2 and -3, not 2 and 3.","box_2d":[717,18,949,424]},{"kind":"correction","text":"x = -2, -3","box_2d":[717,18,949,424]},{"kind":"note","text":"Check signs: (x+2)(x+3) = 0 → x = -2, -3","box_2d":[400,18,600,974]}]}
```

## A+explanation · annotate

- ✅ structured output validates
- ✅ transcribed line 1
- ✅ transcribed line 2
- ✅ transcribed line 3
- ✅ marks a mistake
- ✅ the mistake mark is on the last line
- ✅ correction gives −2 and −3
- ✅ summary says there is a mistake
- ✅ marks become valid canvas commands

```
{"transcription":"x²+5x+6=0\n(x+2)(x+3)=0\nx=2,3","summary":"The student factored correctly but wrote the solutions with incorrect signs.","annotations":[{"kind":"cross","text":"x = 2, 3 is wrong — signs are flipped.","box_2d":[700,18,930,420]},{"kind":"correction","text":"x = -2, -3","box_2d":[700,18,930,420]},{"kind":"note","text":"Factoring is correct — only final answer is wrong.","box_2d":[400,18,600,970]}]}
```

## B · chat

- ❌ answered — server: Ollama's model stopped while answering, usually because the computer ran out of memory. Close other apps and try again, or choose a smaller model (qwen3-vl:2b-instruct) in AI settings. (an error was encountered while running the model: unexpected EOF)
- ❌ read 2x + 3 = 11
- ❌ says it is correct

```
server: Ollama's model stopped while answering, usually because the computer ran out of memory. Close other apps and try again, or choose a smaller model (qwen3-vl:2b-instruct) in AI settings. (an error was encountered while running the model: unexpected EOF)
```

## B · annotate

- ✅ structured output validates
- ✅ uses a check mark
- ✅ no cross on correct work
- ✅ summary and notes do not claim a mistake

```
{"transcription":"2x + 3 = 11\n2x = 8\nx = 4","summary":"The student solved the linear equation correctly, arriving at x = 4.","annotations":[{"kind":"check","text":"Correct first step: subtract 3 from both sides.","box_2d":[48,39,280,960]},{"kind":"check","text":"Correct second step: divide both sides by 2.","box_2d":[388,39,620,570]},{"kind":"check","text":"Correct final answer: x = 4.","box_2d":[750,39,950,440]}]}
```

## C · chat

- ✅ answered
- ✅ weight / gravity (W)
- ✅ normal force (N)
- ✅ applied force (F)
- ✅ friction (f)

```
You’ve drawn a clear free-body diagram for a block on a horizontal surface.

Labels:
- $N$: Normal force — perpendicular to the surface, upward.
- $W$: Weight — downward gravitational force.
- $F$: Applied force — horizontal, pushing the block rightward.
- $f$: Friction force — horizontal, opposing motion (leftward).

You’ve correctly shown all four forces acting on the block.

Next step:
Identify if the block is accelerating or at rest. If accelerating, use Newton’s second law to relate net force to mass and acceleration.

If you’re unsure about direction of friction, recall: friction opposes relative motion or attempted motion. Since $F$ pushes right, friction acts left.

Let me know if you want to proceed with solving for acceleration or other quantities.
```

## D · chat

- ✅ answered
- ✅ stroma
- ✅ oxygen

```
The Calvin cycle happens in the **stroma** of the chloroplast.

The light-dependent reactions release **oxygen (O₂)** as a byproduct.

---

✅ Correct.  
Your notes are accurate:  
- Calvin cycle → stroma  
- Light-dependent reactions → O₂ released

If you’re writing this out, make sure to label the locations clearly and use the correct chemical formula for oxygen gas.

Want to double-check your understanding? Try sketching a quick diagram showing chloroplast structure with arrows pointing to thylakoids (light reactions) and stroma (Calvin cycle).  
Or ask: *What is the main input to the Calvin cycle?* — that’s CO₂, which you already mentioned.  

You’re doing great — keep going!
```

## E · chat

- ✅ answered
- ✅ final speed 20 m/s
- ✅ distance 80 m

```
Given:  
- Initial velocity $ u = 0 $ m/s (starts from rest)  
- Acceleration $ a = 2.5 $ m/s²  
- Time $ t = 8.0 $ s  

**Final speed:**  
Use $ v = u + at $  
$$
v = 0 + (2.5)(8.0) = 20.0 \text{ m/s}
$$

**Distance travelled:**  
Use $ s = ut + \frac{1}{2}at^2 $  
$$
s = (0)(8.0) + \frac{1}{2}(2.5)(8.0)^2 = 0 + \frac{1}{2}(2.5)(64) = 80.0 \text{ m}
$$

✅ Final answers:  
- Final speed: $ \boxed{20.0} $ m/s  
- Distance travelled: $ \boxed{80.0} $ m

---

*Note: If you’re working by hand, double-check your arithmetic — especially the squaring of 8.0 and multiplication by 2.5/2.*  
If you want to verify or explore a different approach, ask!
```

## P · practice

- ❌ structured output validates — server: Ollama's model stopped while answering, usually because the computer ran out of memory. Close other apps and try again, or choose a smaller model (qwen3-vl:2b-instruct) in AI settings. (model runner has unexpectedly stopped, this may be due to resource limitations or an internal error, check ollama server logs for details)

```
server: Ollama's model stopped while answering, usually because the computer ran out of memory. Close other apps and try again, or choose a smaller model (qwen3-vl:2b-instruct) in AI settings. (model runner has unexpectedly stopped, this may be due to resource limitations or an internal error, check ollama server logs for details)
```
