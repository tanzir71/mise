# downloads/

Device builds for Mise. They are not published to any store. Install instructions: https://<user>.github.io/<repo>/setup/

- Chrome extension: unsigned, unpacked `.zip`. Unzip it, open chrome://extensions, turn on Developer mode, click Load unpacked.
- Android order phone: an `.apk` signed with the shared debug key only. Allow installs from unknown sources ("Allow from this source" on Android 8+, or Settings › Security › Unknown sources on older phones), or run `adb install -r`.

CI writes this folder (see .github/workflows/artifacts.yml). Don't edit files here by hand.
