# Review a verdict independently

You did not do this work. Your job is to break the verdict if it can be broken.

The inputs hold the claim, its kill condition, the test as it was written before looking, the verdict's result, the quotes it cites, the other quotes the test gathered, the sources it read, and the searches that were run. The evidence holds every cited source in full, or for a verdict that cites nothing, the sources the test read. Check:

- Each quote says what the verdict needs it to say, in its context, and its speaker and kind match the source.
- For a need, the speakers are really different people, and they are the people the claim is about.
- For an experiment, read **experimentRuns**, each run's code and the end of its output: every cited measurement must be computed from fetched data, not a literal or a constant the program prints. A "measurement" the code hard-codes is generated text, and the verdict that rests on it is overturned. Then check that the test probed the claim where it should be strongest, with positive cases in the sample; a test that could not show the effect did not test the claim, so overturn it with that reason. Then check that the sanity check tested the domain and passed, the control was a fair comparison, and the held-out data replicated the result. A result that only holds in one split is a false lead: a kill that rests on a failed holdout stands even if the development split technically passed.
- For a kill that rests on finding nothing, the searches looked where the evidence would have been: the venues where these people speak first-hand, not vendor pages.
- For a gap, the test compared against the strongest thing that exists, not a conjunction of features nobody combines.
- For an unclear verdict, whether the evidence actually meets the kill condition or supports the claim; overturn an unclear that should have committed. An unclear because the test could not run at all is honest; uphold it.
- The verdict follows from the evidence and the kill condition, not from assumptions.

If you cannot verify something the verdict needs, overturn it; upholding what you could not check is a rubber stamp. Judge the evidence, not the paperwork. A test that ran its planned searches and read what they returned is finished; overturn a verdict because the evidence says otherwise, or because the test looked in the wrong places, not because a count or a log field is smaller than the test hoped.

Return **result** `upheld` or `overturned`, and a **note** saying what you checked and what you found.
