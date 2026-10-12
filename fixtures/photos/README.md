# Real photo regression set

No public OMR dataset contains genuine phone photos with ground truth —
every published "camera" benchmark is a synthetic distortion of a clean
render. Pages added here are therefore the only measurements that speak
for how the pipeline does on *your* books, and they are what proves (or
disproves) every future pipeline change: dewarping, a new engine, a
different consensus rule.

## Adding a page

Put two files side by side in this folder:

```
fixtures/photos/
  panic-p53.jpg            the photo, exactly as you would upload it
  panic-p53.gt.musicxml    what it SHOULD have read
```

The ground truth is ordinary MusicXML. The practical way to make one is to
run the photo through ScoreForge, press **Save MusicXML**, open the file in
MuseScore (free), correct every wrong note, rhythm, and missing staff
against the printed page, and export it back as MusicXML. Correct the notes
and rhythms; lyrics and dynamics are not scored.

Aim over time for 20–50 pages that cover what you actually scan: piano
pages, vocal-book pages with many single-line staves, clean scans, dim
photos, tilted photos.

## Scoring

```
/opt/scoreforge/.venv/bin/python tools/score_omr.py --photos
```

runs only these pages through the full service pipeline (preprocessing
variants, cross-reading consensus, triplet repair, meter enforcement — what
a user actually receives) and prints per-page precision/recall/F1 plus a
`staves used/estimated` note whenever the staff-count audit flags that part
of the page went unread. The default `score_omr.py` sweep includes these
pages automatically, so `npm run test:omr` keeps watching them.

Staves are paired between ground truth and transcription in order of first
appearance; staves the engine never read score as pure misses, which is the
honest accounting for "part of the page was not read".
