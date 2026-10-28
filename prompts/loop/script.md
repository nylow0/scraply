# Write the experiment

Write a self-contained program that runs the experiment exactly as the test describes, using only the listed tools. It will run in its own folder on the owner's Windows machine, and the owner reads it before it runs. The folder starts empty except for **ownerFiles**: material the owner handed over, at the listed relative paths; read it from there when the test rests on it.

- Use data that exists **today** (see the inputs); never wait on future events.
- Fetch public data from its source inside the program, and keep downloads small: a sample that answers the question beats a complete archive. Respect the source's documented limits; split a large query into smaller ones. When **workingCodeFromEarlierTests** shows code that already reached the same data, reuse its approach.
- Look before you analyse: right after fetching, print what arrived (status, record count, the fields of one record), and check it against what the analysis needs. When anything is not what you expected, print what you actually got (status, keys, the first 500 characters) before stopping, so the next attempt can fix the cause.
- Run the sanity check first and print whether it passed, as "Sanity check passed" or "Sanity check failed". If it fails, or the data cannot be reached, stop and exit with a nonzero code: a result from a broken setup is not a result. Compare numbers with a tolerance, never with exact equality.
- Then the main measurement, the control, the held-out replication, and every cut the test names, each on its own line with its numbers, their uncertainty, and the held-out value.
- Every number and finding the program prints is computed from the data it fetched. Never print a constant, an assumption, or a conclusion as if it were a measurement; when something cannot be measured, print that it was not measured and why.
- Print plain, labelled sentences that report what was measured, such as "Holdout: error 0.231 against the baseline's 0.238, difference -0.007 (95% interval -0.015 to 0.001)." Later steps quote these lines word for word as evidence, so every result that matters must be printed as a sentence with its numbers.
- End with one line stating whether the prediction held. That line is a summary for the reader; the numbers above it are the evidence.
- It runs unattended with no input: never prompt for anything, such as a passphrase or a confirmation.
- Held-out data stays apart by being left out of every choice the analysis makes, then measured once at the end of this same run. Print the held-out values; never hide, encrypt, or defer them.
- Never print secrets, never write outside the working folder, and stop with a clear message if data cannot be reached.

When earlier attempts are given, they failed, and each comes with its code and the end of its output. Find the actual cause in that output, change only what it requires, and say what the cause was and what changed in **explanation**. Keep everything that already worked.

Return **files** (name and full content) and **command**: the program and its arguments as a list, such as ["uv", "run", "--with", "pandas", "analysis.py"] or ["bun", "analysis.ts"].
