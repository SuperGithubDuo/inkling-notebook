# Live local-model results: qwen3-vl:2b-instruct

Ollama 0.40.13 at http://127.0.0.1:11434, 2026-10-29T05:01:03.838Z. Images: tests/fixtures/handwriting/ (as Inkling sends them).

| Scenario | Task | Result | Streamed chunks | First text | Total | Tokens in/out | Structured | Checks passed |
|---|---|---|---|---|---|---|---|---|
| A | chat | answered | 175 | 75.8 s | 115.3 s | 1315/198 | n/a | 5/5 |
| A | annotate | answered | 0 | 78.9 s | 105.0 s | 1483/132 | valid | 5/8 |
| B | chat | answered | 96 | 81.2 s | 101.7 s | 1330/105 | n/a | 3/3 |
| B | annotate | answered | 0 | 78.6 s | 139.3 s | 1498/276 | valid | 3/3 |
| C | chat | answered | 160 | 81.5 s | 113.9 s | 1341/161 | n/a | 4/5 |
| D | chat | answered | 135 | 2.7 s | 22.3 s | 354/139 | n/a | 3/3 |
| E | chat | answered | 268 | 2.6 s | 48.0 s | 344/300 | n/a | 1/3 |
| P | practice | answered | 0 | 2.4 s | 42.4 s | 212/295 | valid | 3/3 |
| P | check | answered | 0 | 3.7 s | 10.8 s | 274/54 | valid | 2/2 |
| P | check | answered | 0 | 0.6 s | 15.7 s | 278/113 | valid | 1/1 |

## A · chat

- ✅ answered
- ✅ streamed in several chunks
- ✅ read the factorisation
- ✅ gives the roots −2 and −3
- ✅ says x = 2, 3 is wrong

```
I read the handwritten work as:

$$
x^2 + 5x + 6 = 0
$$
$$
(x + 2)(x + 3) = 0
$$
$$
x = 2, 3
$$

The first mistake is in the final step. The student has incorrectly concluded that the solutions are $x = 2$ and $x = 3$. This is wrong because they are not the roots of the equation. The correct approach is to solve for $x$ by setting each factor equal to zero.

The student correctly factored the quadratic as $(x + 2)(x + 3) = 0$, which gives the solutions $x = -2$ and $x = -3$. These are the roots of the equation, not $2$ and $3$ as the student has written. The correct answer is that $x = -2$ and $x = -3$.
```

## A · annotate

- ✅ structured output validates
- ✅ transcribed line 1
- ✅ transcribed line 2
- ✅ transcribed line 3
- ❌ marks a mistake — check
- ❌ the mistake mark is on the last line
- ❌ correction gives −2 and −3 — Good job!
- ✅ marks become valid canvas commands

```
{"transcription":"x² + 5x + 6 = 0\n(x + 2)(x + 3) = 0\nx = 2, 3","summary":"The student has solved the quadratic equation by factoring and finding the roots, which are x = 2 and x = 3. The work is correct.","annotations":[{"kind":"check","text":"Good job!","box_2d":[0,0,1000,1000]}]}
```

## B · chat

- ✅ answered
- ✅ read 2x + 3 = 11
- ✅ says it is correct

```
I read the handwriting in the image. The student has written:
- $2x + 3 = 11$
- $2x = 8$
- $x = 4$

The first step is correct: subtracting 3 from both sides of the equation gives $2x = 8$. This is correct.

The second step is also correct: dividing both sides by 2 gives $x = 4$.

There are no mistakes in the student's work. The solution is correct.
```

## B · annotate

- ✅ structured output validates
- ✅ uses a check mark
- ✅ no cross on correct work

```
{"transcription":"2x + 3 = 11\n2x = 8\nx = 4","summary":"The student solved the equation 2x + 3 = 11 by isolating x, but the final answer is incorrect.","annotations":[{"kind":"check","text":"Correct step: isolate x by subtracting 3 from both sides.","box_2d":[38,46,288,961]},{"kind":"circle","text":"2x = 8","box_2d":[407,46,615,574]},{"kind":"arrow","text":"x = 4","box_2d":[754,46,955,446]},{"kind":"note","text":"The student solved the equation correctly but made an error in the final step.","box_2d":[754,46,955,574]}]}
```

## C · chat

- ✅ answered
- ❌ weight / gravity (W)
- ✅ normal force (N)
- ✅ applied force (F)
- ✅ friction (f)

```
I see the free-body diagram you've drawn. Let's break it down:

- **N**: This represents the normal force, which is the upward force exerted by the floor on the block.
- **F**: This is the applied force pushing the block to the right.
- **f**: This is the frictional force opposing the motion of the block.

The labels are correct in terms of their meanings. However, I notice that the diagram shows a horizontal line with an arrow pointing left, labeled 'f'. This likely represents the frictional force, which acts opposite to the direction of motion. The diagram seems to be missing the label for the normal force, but it's not incorrect.

The next step is to identify the forces and their directions correctly. I can help you with that.
```

## D · chat

- ✅ answered
- ✅ stroma
- ✅ oxygen

```
You wrote:  
"According to my notes, where does the Calvin cycle happen, and what gas is released by the light-dependent reactions?"

What you're asking is correct based on your notes. Let's break it down:

- The **Calvin cycle** happens in the **stroma** of the chloroplast.
- The **light-dependent reactions** release **oxygen (O₂)**.

So, to answer your question:
> Where does the Calvin cycle happen?  
> → In the **stroma**.

> What gas is released by the light-dependent reactions?  
> → **Oxygen (O₂)**.

That’s all you need. No more than that.
```

## E · chat

- ✅ answered
- ❌ final speed 20 m/s
- ❌ distance 80 m

```
You read: "A car starts from rest and accelerates uniformly at 2.5 m/s² for 8.0 s."  
This is correct.

**Step 1:** Use the equation for final speed:  
$v = u + at$  
where:  
- $u = 0$ (starts from rest),  
- $a = 2.5\ \text{m/s}^2$,  
- $t = 8.0\ \text{s}$.

$$
v = 0 + (2.5)(8.0) = 20\ \text{m/s}
$$

**Step 2:** Use the equation for distance:  
$s = ut + \frac{1}{2}at^2$  
- $u = 0$,  
- $a = 2.5\ \text{m/s}^2$,  
- $t = 8.0\ \text{s}$.

$$
s = 0 + \frac{1}{2}(2.5)(8.0)^2 = \frac{1}{2}(2.5)(64) = 80\ \text{m}
$$

**Answer:**  
- Final speed: $20\ \text{m/s}$  
- Distance travelled: $80\ \text{m}$  

✅ All steps are correct and consistent with the given equations. No errors detected.
```

## P · practice

- ✅ structured output validates
- ✅ two problems
- ✅ every problem has hints

```
{
  "topic": "solving linear equations",
  "problems": [
    {
      "question": "Solve the equation: $ 3x + 5 = 14 $.",
      "difficulty": "easy",
      "hints": [
        "First, isolate the variable $ x $ by subtracting 5 from both sides.",
        "Then, divide both sides by 3 to solve for $ x $."
      ],
      "answer": "x = 3",
      "solution": "Start with $ 3x + 5 = 14 $. Subtract 5 from both sides: $ 3x = 9 $. Now divide both sides by 3: $ x = 3 $."
    },
    {
      "question": "Solve the equation: $ 2y - 8 = 6 $.",
      "difficulty": "easy",
      "hints": [
        "Add 8 to both sides to isolate the term with $ y $.",
        "Then divide both sides by 2 to solve for $ y $."
      ],
      "answer": "y = 7",
      "solution": "Start with $ 2y - 8 = 6 $. Add 8 to both sides: $ 2y = 14 $. Now divide both sides by 2: $ y = 7 $."
    }
  ]
}
```

## P · check

- ✅ check validates
- ✅ right answer judged correct

```
{
  "verdict": "correct",
  "transcription": "x = 3",
  "feedback": "Great job solving the equation! You correctly found x = 3. The steps are right, and the answer matches the expected result."
}
```

## P · check

- ✅ wrong answer not judged correct

```
{
  "verdict": "incorrect",
  "transcription": "x = 12345",
  "feedback": "The student's answer is incorrect. The equation $ 3x + 5 = 14 $ is solved by isolating $ x $, which involves subtracting 5 from both sides and then dividing by 3. The correct solution is $ x = 3 $. The student's answer is clearly wrong, and it appears they may have made a mistake in the arithmetic or misread the equation."
}
```
