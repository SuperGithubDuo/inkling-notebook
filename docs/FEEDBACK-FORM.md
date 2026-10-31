# Beta tester feedback form

A short form (about 3 minutes) that testers can fill in **without a GitHub account or any sign-in**. The app's *Send Feedback* opens it once its address is built in as `INKLING_FEEDBACK_URL` (below). No address has been chosen yet: create the form, then follow *Connect it to the app*.

## Form text

**Title:** Inkling Beta 2 feedback

**Description (shown at the top):**
> Thanks for testing Inkling! This takes about 3 minutes.
> **Please don't paste, type out or upload anything from your notebooks** — no personal notes, homework, names or screenshots of your pages. Describe what happened in your own words instead.
> Only the "contact" question at the end asks for anything personal, and it's optional.

### Your setup
1. **Which computer did you use?** *(multiple choice, required)* — Windows 11 · Windows 10 · Windows on ARM (Snapdragon, Surface Pro X) · Mac with Apple silicon (M1 or later) · Mac with Intel · Other
2. **Which version of Inkling?** *(short answer, optional)* — hint: *Help → About Inkling* (Windows) or *Inkling → About Inkling* (Mac). Expected: 0.2.0-beta.2
3. **How did you write or draw?** *(checkboxes, required)* — Pen or stylus · Finger on a touch screen · Mouse · Trackpad
4. **Which pen or tablet, if any?** *(short answer, optional)* — e.g. Surface Pen, Wacom One, Apple Pencil via Sidecar

### Installing and using
5. **How easy was installing Inkling?** *(linear scale 1–5: very hard → very easy, required)*
6. **Did the security warning (Windows "protected your PC" / macOS "Open Anyway") cause trouble?** *(multiple choice)* — No · Yes, but I got past it · Yes, I couldn't open Inkling
7. **Overall, how easy is Inkling to use?** *(linear scale 1–5: very hard → very easy, required)*
8. **How did writing feel?** *(linear scale 1–5: unusable → as good as paper)*
9. **Did you notice any of these while writing?** *(checkboxes)* — Lag behind the pen · Missing or broken strokes · Palm or hand leaving marks · Pen pressure not working · Touch scrolling/zooming when I meant to write · Eraser problems · None

### The AI tutor
10. **Did you use the AI tutor?** *(multiple choice, required)* — Yes · I tried, but it didn't work · No
11. **How accurate were its answers?** *(linear scale 1–5: mostly wrong → always right)*
12. **Did it read your handwriting correctly?** *(multiple choice)* — Always · Mostly · Sometimes · Rarely · Didn't use it
13. **Did the "answers left today" count look right?** *(multiple choice)* — Yes · No, it didn't change · No, it ran out too soon · Didn't notice
14. **Describe a wrong or unhelpful answer, if any.** *(paragraph, optional)* — "Describe the kind of problem (e.g. 'a quadratic with a sign error'), not your actual notes."

### Problems and ideas
15. **Did anything go wrong?** *(paragraph, optional)* — "What did you do, what happened, what did you expect? Error messages help. Please don't include notebook contents."
16. **Did you lose any work?** *(multiple choice)* — No · Yes (please describe above)
17. **What one change would make Inkling most useful to you?** *(paragraph, optional)*
18. **Anything else?** *(paragraph, optional)*

### Optional contact
19. **May we contact you about your answers? If so, leave an email address. Under 18: a parent's or guardian's email only.** *(short answer, optional)* — "Optional. Used only to follow up on this feedback and deleted after the beta."

## Form settings

Whatever tool you use, the form must open and submit **without signing in**:
- **Google Forms:** in *Settings → Responses*, turn **off** *Collect email addresses* and **off** *Limit to 1 response* (it forces a Google sign-in). Don't add *File upload* questions (they also force sign-in, and invite screenshots of notes).
- **Microsoft Forms:** *Settings → Who can fill out this form → Anyone can respond*.
- **Tally** or similar: public by default. Don't add file uploads.
- Use the form's normal **https** link (Google: *Send → link icon*, e.g. `https://docs.google.com/forms/d/e/…/viewform`). Shortened links work too.
- Decide who can see responses, and delete them (including the optional emails) when the beta ends. Testers of any age may answer; only a parent's or guardian's contact is collected for a tester under 18 (question 19), and children's answers are handled under the parental-consent arrangement in `docs/READINESS.md`.

## Connect it to the app

The app reads the address at **build time**, so the installers must be rebuilt after it is set:

1. GitHub → repository **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `INKLING_FEEDBACK_URL`, value the form's https link (or a `mailto:` address).
2. Rebuild the draft release: `git push origin origin/beta-release:refs/heads/build/draft-release --force` (see `docs/RELEASING.md`). The new installers replace the old ones in the draft, so the checksums change; the workflow rewrites the draft's notes with the new checksums and the form link.
3. In the run's annotations, **Feedback link built in** must name your form (a **Feedback link** warning means the variable wasn't set).
4. Check by hand: *Help → Send Feedback or Report a Problem* opens the form in the browser.

Inkling adds two parameters to the link: `title` and `body`, where `body` holds the app version and system (for example `Inkling 0.2.0-beta.2 on Windows (x64)`), never notebook content. Google and Microsoft Forms ignore them. In Tally, a hidden field named `body` records them automatically.
