#!/bin/bash
#
# Build a debug APK.
#
# www/ is this app's own source — nothing is copied in from ../web. Edit it
# directly, then run this.
#
# JAVA_HOME and ANDROID_HOME are pinned rather than inherited: Capacitor 8
# needs a Java 21 toolchain and SDK 36 specifically, and a shell with a
# different default JDK produces a confusing toolchain error deep in Gradle.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export JAVA_HOME="$(brew --prefix openjdk@21)"
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

cd "$HERE"

# Warn before a 90-second build rather than discovering it on the phone.
# These are warnings, not errors: an app with neither value set is still worth
# building to test navigation, which needs no relay at all.
if grep -qE "^\s*RELAY_URL:\s*''" www/assets/config.js; then
    echo ""
    echo "  NOTE: RELAY_URL is unset — the group will stay empty."
    echo "  Map, search, routing and your own position still work."
fi
if grep -qE "^\s*PUBLIC_ORIGIN:\s*''" www/assets/config.js; then
    echo "  NOTE: PUBLIC_ORIGIN is unset — invite links will not open"
    echo "  for anyone else. Joining by six-character code still works."
    echo ""
fi

npx cap sync android

cd "$HERE/android"
./gradlew assembleDebug

APK="$HERE/android/app/build/outputs/apk/debug/app-debug.apk"
echo ""
if [ -f "$APK" ]; then
    echo "APK: $APK"
    ls -lh "$APK" | awk '{print "     " $5}'
    echo ""
    echo "Install on a connected phone:"
    echo "  \$ANDROID_HOME/platform-tools/adb install -r \"$APK\""
else
    echo "build finished but produced no APK" >&2
    exit 1
fi
