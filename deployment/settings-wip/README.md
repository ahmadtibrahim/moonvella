# Settings rewrite — archived WIP, NOT deployable

`admin.settings.tsx.wip` is an unfinished rewrite of `app/routes/admin.settings.tsx`,
kept here as an archive. It is **not a route**: the `.wip` extension keeps it out of
React Router's route glob and out of `tsc` (tsconfig includes `**/*.tsx`), so it can
sit in the tree without arming a route or breaking `npm run typecheck`.

Do not rename it to `.tsx` under `app/routes/` and do not deploy it — see below.

## What it is

The working-tree draft from 2026-09-22 (836 lines). The version here has the two
syntax defects removed and parses clean:

- an orphan `</div>` that closed the root element early and made the
  "Back to Dashboard" `<p>` a second root inside `return (` — esbuild reported it as
  `350:9: ERROR: Expected ")" but found "style"`;
- a duplicate module-scope `function statusColor(...)`, byte-identical to the copy
  above it. It only surfaces *after* the first fix, as
  `The symbol "statusColor" has already been declared`.

Result: 829 lines, `esbuild --loader:.tsx=tsx` clean.

## Why it is not deployable

`npm run typecheck` gives **17 errors** against this file (the tree's own file: 0).
They are not cosmetic:

- `saveIntegrationCredentials`, `disconnectIntegration`, `IntegrationStateView` and
  `DEFAULTS` are called but never imported — ReferenceError on credential save or
  disconnect.
- line 79 `formData.entries().filter(...)` — a `FormDataIterator` has no `.filter`;
  TypeError on submit. Needs `Array.from(formData.entries())`.
- The draft is two half-drafts spliced together. `DetailCard` renders
  `<StripeCredentialForm showCredentials setShowCredentials />`, but the forms are
  declared `CredentialFormProps = { integration, onSave, onDisconnect }` — they take
  a client-side `onSave` callback that no endpoint implements, and their field names
  (`STRIPE_SECRET_KEY`, …) do not match the `secret_*` prefix the action filters on.
- `key` is a reserved React prop, so `key={i.key}` never reaches the component;
  `DEFAULTS[key]` is always undefined and `credentialHints` is always empty.
- `<DetailForm />` is a stub that returns `null`.

## Superseded

The live route already implements all four intents (`refresh_integration`,
`clear_integration_error`, `save_credentials`, `disconnect_integration`) with the
correct `secret_*` form fields, `CREDENTIAL_KEYS` / `OPERATIONAL_KEYS`, and
`useNavigation()`-driven `isSubmitting`. The draft went 836 → 638 → 632 lines in the
tree on 2026-09-22 and the 632-line result is what is committed and deployed.

Finishing this file means choosing between its two designs and rewriting the
credential forms to post through the action — not a mechanical repair.

## Checking it

The image has no `tsconfig.json`, so typecheck against a throwaway copy of the tree
with the file renamed back to its route path. `--user 0:0` is required: the container
runs as uid 10001 and cannot write a root-owned mount.

```
mkdir -p /tmp/mv-tc
tar -C /opt/moonvella/app -cf - --exclude=./node_modules --exclude=./.git \
    --exclude=./build --exclude=./uploads . | tar -C /tmp/mv-tc -xf -

docker run --rm --user 0:0 -v /tmp/mv-tc:/repo \
  -v /opt/moonvella/app/deployment/settings-wip:/mnt:ro --entrypoint sh moonvella:local -c '
    ln -sfn /app/node_modules /repo/node_modules
    cp /mnt/admin.settings.tsx.wip /repo/app/routes/admin.settings.tsx
    cd /repo
    /app/node_modules/.bin/react-router typegen >/dev/null
    /app/node_modules/.bin/tsc --noEmit'
```

For the parse alone (much faster): `esbuild app/routes/admin.settings.tsx
--loader:.tsx=tsx --outfile=/dev/null`. The parser is the weaker gate — it passes a
file that `tsc` rejects.
