#!/usr/bin/env bash
set -euo pipefail

SPEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SPEC_DIR/.." && pwd)"
TLA_VERSION="1.8.0"
TLA_SHA256="e1f11b75c4b5bc4478ba0ac5cb6ae28e40a01b0016bc33e0aa97da22dfdbcd7f"
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"
CACHE_DIR="${HOME}/.cache/ambitious"
TLA_JAR="${CACHE_DIR}/tla2tools-${TLA_VERSION}.jar"
MAX_BROKEN_DIFF_LINES=8

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

sha256_of() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

fetch_tla_jar() {
  mkdir -p "$CACHE_DIR"
  if [ -f "$TLA_JAR" ] && [ "$(sha256_of "$TLA_JAR")" = "$TLA_SHA256" ]; then
    return
  fi
  local partial
  partial="$(mktemp "${CACHE_DIR}/tla2tools.XXXXXX")"
  curl -sSfL -o "$partial" "$TLA_URL" || { rm -f "$partial"; fail "could not download $TLA_URL"; }
  local actual
  actual="$(sha256_of "$partial")"
  if [ "$actual" != "$TLA_SHA256" ]; then
    rm -f "$partial"
    fail "tla2tools.jar SHA-256 is $actual, expected $TLA_SHA256"
  fi
  mv -f "$partial" "$TLA_JAR"
}

run_tlc() {
  local tla="$1" cfg="$2" out="$3" meta
  meta="$(mktemp -d)"
  set +e
  (cd "$REPO_DIR" && mise exec -- java -XX:+UseParallelGC -cp "$TLA_JAR" tlc2.TLC \
    -workers 1 -metadir "$meta" -noGenerateSpecTE -config "$cfg" "$tla") >"$out" 2>&1
  local code=$?
  set -e
  rm -rf "$meta"
  return "$code"
}

state_count() {
  grep -E '^[0-9]+ states generated, [0-9]+ distinct states found' "$1" | tail -1
}

expected_invariant() {
  sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([A-Za-z0-9_]*\)\".*$/\1/p" "$SPEC_DIR/broken/EXPECTED.json"
}

check_passing() {
  local cfg="$1" name out
  name="$(basename "$cfg" .cfg)"
  out="$(mktemp)"
  if ! run_tlc "$SPEC_DIR/$name.tla" "$cfg" "$out"; then
    cat "$out"
    fail "$name: TLC reported an error"
  fi
  grep -q 'Model checking completed. No error has been found.' "$out" || { cat "$out"; fail "$name: TLC did not finish"; }
  local distinct
  distinct="$(state_count "$out" | sed -E 's/.*, ([0-9]+) distinct.*/\1/')"
  [ "${distinct:-0}" -gt 1000 ] || fail "$name: only ${distinct:-0} distinct states, the model is not exploring"
  echo "PASS  $name: every invariant holds ($(state_count "$out"))"
  rm -f "$out"
}

check_broken() {
  local cfg="$1" name out expected base
  name="$(basename "$cfg" .cfg)"
  expected="$(expected_invariant "$name")"
  [ -n "$expected" ] || fail "$name: not listed in spec/broken/EXPECTED.json"
  grep -Eq "^[[:space:]]*${expected}[[:space:]]*$" "$cfg" || fail "$name: $cfg does not check $expected"
  base="$SPEC_DIR/TaskLifecycle.tla"
  local changed
  changed="$(diff <(sed "s/MODULE TaskLifecycle/MODULE $name/" "$base") "$SPEC_DIR/broken/$name.tla" | grep -c '^[<>]' || true)"
  [ "$changed" -ge 1 ] || fail "$name: identical to TaskLifecycle.tla"
  [ "$changed" -le "$MAX_BROKEN_DIFF_LINES" ] || fail "$name: differs from TaskLifecycle.tla in $changed lines, more than one removed guard"
  out="$(mktemp)"
  if run_tlc "$SPEC_DIR/broken/$name.tla" "$cfg" "$out"; then
    cat "$out"
    fail "$name: expected $expected to be violated, but TLC passed"
  fi
  if ! grep -q "Error: Invariant ${expected} is violated." "$out"; then
    cat "$out"
    fail "$name: TLC failed, but not on invariant $expected"
  fi
  echo "PASS  broken/$name: fails on $expected as expected, $changed lines differ from the model ($(state_count "$out"))"
  rm -f "$out"
}

command -v mise >/dev/null || fail "mise is required (https://mise.jdx.dev)"
(cd "$REPO_DIR" && mise trust --quiet && mise install --quiet)
fetch_tla_jar
echo "TLC from tla2tools.jar v${TLA_VERSION} sha256 ${TLA_SHA256}"
(cd "$REPO_DIR" && mise exec -- java -version 2>&1 | head -1)

shopt -s nullglob
passing=("$SPEC_DIR"/*.cfg)
broken=("$SPEC_DIR"/broken/*.cfg)
[ "${#passing[@]}" -ge 1 ] || fail "no spec/*.cfg found"

listed="$(grep -c '":' "$SPEC_DIR/broken/EXPECTED.json")"
[ "$listed" -eq "${#broken[@]}" ] || fail "EXPECTED.json lists $listed variants, spec/broken has ${#broken[@]}"

for cfg in "${passing[@]}"; do check_passing "$cfg"; done
for cfg in "${broken[@]}"; do check_broken "$cfg"; done
echo "OK: ${#passing[@]} model(s) pass, ${#broken[@]} broken variant(s) fail on the expected invariant"
