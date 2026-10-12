# Real photo regression set

No public OMR dataset contains real phone photos with ground truth; the
published "camera" benchmarks are synthetic distortions of clean renders.
Pages added here measure how the pipeline does on your own books, and every
future pipeline change (dewarping, a new engine, a different consensus rule)
should be judged against them.

## Adding a page

Put two files side by side in this folder:

```
fixtures/photos/
  panic-p53.jpg            the photo, exactly as you would upload it
  panic-p53.gt.musicxml    what it should have read
```

The ground truth is ordinary MusicXML. The practical way to make one: run the
photo through ScoreForge, press **Save MusicXML**, open the file in MuseScore
(free), correct every wrong note, rhythm and missing staff against the
printed page, and export it back as MusicXML. Only notes and rhythms are
scored; lyrics and dynamics are not.

Aim over time for 20 to 50 pages covering what you actually scan: piano
pages, vocal-book pages with many single-line staves, clean scans, dim
photos, tilted photos.

## Scoring

```
/opt/scoreforge/.venv/bin/python tools/score_omr.py --photos
```

runs only these pages through the full service pipeline (preprocessing
variants, cross-reading consensus, triplet repair, meter enforcement), which
is what a user actually receives, and prints per-page precision, recall and
F1, plus a `staves used/estimated` note whenever the staff-count audit flags
that part of the page went unread. The default `score_omr.py` sweep includes
these pages automatically, so `npm run test:omr` keeps watching them.

Staves are paired between ground truth and transcription in order of first
appearance. Staves the engine never read score as misses.
