# Inkling Beta 2 — short feedback form (ready to copy)

## Publication status

**Prepared, not published. No working feedback URL yet.** Tally's anonymous editor was reachable, but Publish opened “Create your Tally account.” The available browser session had no owner login and the browser vault returned no saved logins. The user's running Chrome profile was locked, so the browser automation used a fresh profile rather than their account. Missing access: an owner-controlled Tally account (or permission/access to an existing Google/Microsoft Forms workspace). Do not create a disposable unowned form or put a placeholder into the app.

## Exact form

**Title:** Inkling Beta 2 feedback

**Introduction:**
> Thanks for trying Inkling. This takes about three minutes. No sign-in or contact details are required. Please use made-up examples when testing. Do not include your name, age, school, email, notebook pages, homework, screenshots, API keys or other personal information. Describe problems without copying your notes. Skip any question you cannot answer.

1. **Which setup did you test?** Required, multiple choice: Windows 11 (Intel/AMD) / Windows 10 (Intel/AMD) / Windows on ARM / Mac with Apple silicon / Mac with Intel / Other or unsure. Optional version/device details can go in question 9; do not request a serial number.
2. **How did installation and first launch go?** Required, multiple choice: Easy; opened normally / Security warning appeared, but I opened it / Installed, but would not open / Could not install / Did not try installing.
3. **How easy was the interface to use?** Optional, multiple choice: 1 Very difficult / 2 Difficult / 3 Neither / 4 Easy / 5 Very easy / Could not try it.
4. **How did you write or draw?** Required, checkboxes: Physical pen or stylus / Finger on touchscreen / Mouse / Trackpad / Did not write or draw.
5. **How did handwriting or drawing feel?** Optional, checkboxes: Worked well / Noticeable lag / Missing or broken strokes / Unwanted palm or touch marks / Pressure did not work / Eraser or lasso problem / Could not try it. Hint: Choose “Worked well” only if you saw none of these problems.
6. **What happened when you used the AI Tutor?** Optional, multiple choice: Read my made-up example and helped correctly / Misread handwriting / Read it correctly but answered incorrectly / Error, timeout or no answer / Did not use AI. Hint: AI can make mistakes; do not paste the example or your notes here.
7. **Did AI permission and the answers-left message make sense?** Optional, multiple choice: Both were clear / Permission was unclear / Answers-left message seemed wrong / Both were unclear or wrong / Did not notice or did not use AI.
8. **Did your work survive saving and reopening?** Required, multiple choice: Yes / Some work was missing / All work was missing / Did not close and reopen. Hint: If anything was missing, describe the steps below without including the missing contents.
9. **What went wrong, if anything?** Optional paragraph, recommended maximum 1,500 characters. Hint: Include app version, feature (such as install, PDF import/export, backup, lasso or tutor), steps, expected result, actual result and a non-sensitive error message. Do not attach files or paste notebook contents.
10. **What one change would make Inkling more useful?** Optional paragraph, recommended maximum 500 characters.

**Confirmation:**
> Thank you. Your feedback helps prioritize the next beta. This form is not an emergency or support channel. Keep a separate backup of important work and check AI answers yourself.

## Owner settings and acceptance check

- Public HTTPS responder link; no sign-in, verified email, organization restriction or one-response-per-account requirement.
- No contact question, DOB, school, file upload, response receipts, public response summary, marketing opt-in, hidden user identifiers or embedded analytics.
- Limit response access to named maintainers. Set and document a deletion date before inviting testers; review/export/delete responses on that schedule. Do not promise a retention period until the owner actually configures a process.
- Review the form host's own IP/cookie/log retention and child-use terms. A no-sign-in form is not necessarily anonymous to its host. For child participants, arrange a reviewed guardian-mediated feedback route; do not imply this form alone resolves COPPA obligations.
- In Google Forms: turn off email collection and Limit to 1 response; enable access for anyone with the link; add no upload questions. In Microsoft Forms select Anyone can respond. Tally requires owner access to publish this prepared content.
- Open the final responder link in a signed-out/private browser, submit one clearly marked synthetic QA response, verify it appears in the owner's response view, then delete that response and verify deletion. Only then call the link working.

## Connect to the installer (Claude owns rebuilds)

1. Set repository Actions **variable** `INKLING_FEEDBACK_URL` to the verified public HTTPS responder URL, through Settings → Secrets and variables → Actions → Variables. Do not set it to a draft/editor URL or GitHub issue form.
2. Ask Claude to include the variable in the next approved release build. This is a **build-time** value; setting it does not repair an existing installer. Do not independently force-push a release branch or trigger builds from this review.
3. Check the workflow's feedback-link annotation and release notes, then install the rebuilt artifact. Verify Help → Send Feedback or Report a Problem opens the final form with no sign-in and no notebook content in its URL.
4. Recompute installer hashes after rebuilding. The old checksum is no longer applicable.

The application may append `title` and `body` containing version and OS. Avoid collecting extra hidden fields unless explicitly needed; this short form does not need them.
