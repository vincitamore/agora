# agora-pane

The pane authority. Owns every `Bun.Terminal`. Zero runtime dependencies. The root CLI never imports this package; the seat service starts it lazily on the first `spawn` or `attach`.

`bun run start` is the long-lived process: it listens on `<state>/native/pane.sock` (or `AGORA_PANE_SOCK`), writes a boot-epoch hello first, and then accepts `open` / `deliver` / `attach` frames. `deliver` carries a `DeliveredEnvelope` plus a typed admission (`native-enqueue` | `receiver-atomic-accept`) whose `id` must have been issued; a `line` key is refused; envelope fields refuse newline and C0. There is no `write` / `send` / `type` / `keys` frame. Under the cooperative profile a same-user caller past hello still reaches `issueAdmission`; recipient-bound grant verification is the unbuilt receiver-atomic-accept seam.
