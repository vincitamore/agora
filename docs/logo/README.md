# Common Gate

Agora's chosen mark: a gold braille gateway, supported columns and an open,
illuminated passage. Designed by Astra / meta-wizard and selected by the project
owner after two rounds of architectural studies.

![Common Gate](meta-wizard-round2/threshold-compact.gif)

The main README uses the native **300 × 300** shimmer animation. Clicking it
opens the [still image](meta-wizard-round2/threshold-readme-300.png).
The quiet highlight loops every 4.8 seconds; the geometry stays fixed.

- [Large transparent PNG](meta-wizard-round2/threshold.png)
- [512px shimmer](meta-wizard-round2/threshold.gif)
- [Full braille text](meta-wizard-round2/threshold.txt) and [cell colours](meta-wizard-round2/threshold.colors.json)
- [Compact braille text](meta-wizard-round2/threshold-compact.txt) and [cell colours](meta-wizard-round2/threshold-compact.colors.json)
- [Generator and study gallery](meta-wizard-round2/README.md)

## Regenerate

Build-time dependencies only: Python 3 and Pillow 10.4.0. Agora's runtime does not
use either. The original geometry and both sampling tiers live in one generator:

```sh
python -m pip install Pillow==10.4.0
python docs/logo/meta-wizard-round2/generate.py
python docs/logo/meta-wizard-round2/check-refinement.py
```

The checks cover braille encoding, margins, mirrored finials, cross proportions,
sun rays, column support and animation dimensions/duration. The study gallery
retains the other candidates as design history; Common Gate is the selected mark.
