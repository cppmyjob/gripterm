#!/bin/sh
#
# The gate, in the place a promise cannot be kept in.
#
# Redaction 1 of Ш6 said "while there is no CI, the output is attached to every
# push". That is exactly the kind of trace a person can decline to read (II.6),
# so it is executed here instead. Measured 2026-08-25 before this file existed:
# `.github` did not exist, `core.hooksPath` was unset, and `.git/hooks` held
# nothing but git's own `.sample` files -- all three, because the middle one on
# its own establishes nothing (unset means the DEFAULT hooks directory, not an
# empty one). Nothing ran anything unless somebody typed it.
#
# WHAT IT RUNS, and why not more. `pnpm run gate:fast`: types, lint, the unit
# suites with their coverage thresholds. About fifty seconds, no editor, no
# window on anybody's desktop. The full gate adds the live suites and the
# two-sitting stand: ten minutes and four windows. A hook that did THAT on every
# push would be gone within a day, and a hook that is gone checks nothing. So the
# ten minutes are owed BEFORE a push and not on every one: `pnpm run gate` leaves
# a receipt naming the revision it checked, and the second half of this hook
# refuses a push whose commits have no such receipt.
#
# HOW TO GET PAST IT, said out loud because a bypass nobody names is a bypass
# that gets used silently:
#
#   git push --no-verify        -- this file does not run at all. Nothing here
#                                  can see that, and nothing here pretends to.
#                                  Say so in the register.
#   GRIPTERM_GATE_RECEIPT=no    -- run the fast level, skip the receipt check.
#                                  Recorded in .gate/receipts.ndjson.
#
# HOW TO TAKE IT OFF, in one command:
#
#   rm .git/hooks/pre-push
#
# HOW IT WENT ON, and how it goes on again in a fresh clone -- `.git/hooks` is
# not tracked, so every clone starts without it:
#
#   printf '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/tools/pre-push.sh" "$@"\n' > .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
#
set -u

repo=$(git rev-parse --show-toplevel)
cd "$repo" || exit 1

echo "pre-push: the fast gate (types, lint, unit). \`git push --no-verify\` skips all of this."

if ! pnpm run gate:fast; then
  echo ""
  echo "pre-push: REFUSED -- the fast gate is red. Nothing was pushed."
  exit 1
fi

if [ "${GRIPTERM_GATE_RECEIPT:-yes}" = "no" ]; then
  # Written down where the receipts are, because a bypass that leaves nothing
  # behind is a bypass nobody can count. This is the one of the three that CAN
  # be recorded: `--no-verify` never reaches this line.
  mkdir -p .gate
  printf '{"kind":"receipt-check-skipped","at":"%s","head":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git rev-parse HEAD)" >> .gate/receipts.ndjson
  echo ""
  echo "pre-push: GRIPTERM_GATE_RECEIPT=no -- the receipt check was skipped on purpose,"
  echo "          and a line saying so went into .gate/receipts.ndjson."
  exit 0
fi

# The commits being pushed arrive on stdin as `<local ref> <local oid> <remote
# ref> <remote oid>`. A local oid of all zeros is a branch being DELETED, which
# pushes no commit and needs no receipt.
zero=0000000000000000000000000000000000000000
unchecked=
while read -r _local_ref local_oid _remote_ref _remote_oid; do
  [ "$local_oid" = "$zero" ] && continue
  if ! node tools/gate-receipt.mjs "$local_oid"; then
    unchecked="$unchecked $local_oid"
  fi
done

if [ -n "$unchecked" ]; then
  echo ""
  echo "pre-push: REFUSED -- no full gate has ever run over:$unchecked"
  echo ""
  echo "  The fast level passed. It is not what \"checked\" means: the live suites"
  echo "  and the two-sitting stand did not run, and those are where the product"
  echo "  meets a real editor."
  echo ""
  echo "  A receipt names a COMMIT, so it can only be earned after the commit exists:"
  echo "  commit first, then \`pnpm run gate\`, then push. A gate run before the commit"
  echo "  vouches for a tree that no longer has a name."
  echo ""
  echo "  Three honest ways on, and they are not equal:"
  echo "    pnpm run gate                 -- ten minutes, four windows, then push."
  echo "    GRIPTERM_GATE_RECEIPT=no git push ...   -- recorded in .gate/receipts.ndjson."
  echo "    git push --no-verify ...      -- leaves NO trace at all. Write it in the register."
  exit 1
fi

echo "pre-push: the fast gate is green and every commit has a full-gate receipt."
exit 0
