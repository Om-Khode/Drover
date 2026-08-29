# Icons

Two marks, on purpose.

| Size | Mark | Why |
| --- | --- | --- |
| 32, 48, 128, 512 | `source-full.png` — browser window, steering wheel, cursor; the silhouette is a **D** | Says what Drover does, and has room to say it |
| 16 | `source-wheel.png` — the wheel alone | 16px is 256 pixels. The full mark's window chrome, traffic lights and cursor collapse into noise at that size; the wheel is the half that still reads |

Both share the navy ground and the blue hub, so they belong to one family at any
size a browser picks.

**Regenerate rather than upscale.** The two `source-*.png` files are the masters.
A new size comes from downscaling a master with LANCZOS, never from resizing one
of the emitted sizes.

`build/build.mjs` copies 16/32/48/128 into both `dist/` targets; `manifest.json`
declares all four for `icons` and `action.default_icon`. Declaring only 128 and
letting the browser downscale is what produces the blue smudge this split exists
to avoid.
