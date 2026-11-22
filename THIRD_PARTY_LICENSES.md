# Third-Party & Upstream Licenses

**Voice Web Bridge** as a whole is distributed under the **GNU General Public License v3.0**
([LICENSE](LICENSE)) with a Section 7 linking exception ([LICENSE-EXCEPTION](LICENSE-EXCEPTION)).

This file preserves the copyright notices, permission notices, and license terms
for upstream and third-party components incorporated into, bundled with, or
vendored in this repository.

---

## 1. Upstream Project: Voice Bridge (MIT License)

This repository is a fork of **Voice Bridge** by PfauMC (`andreypfau`), originally
released under the MIT License. The original unmodified upstream code remains
available under the MIT License from upstream; all modifications and the combined
work in this repository are distributed under GPLv3.

```text
MIT License

Copyright (c) 2026 PfauMC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Shaded Java Dependencies (Bundled in the Plugin JAR)

### bStats (`org.bstats:bstats-bukkit:3.1.0`) — MIT License

```text
MIT License

Copyright (c) 2021 Bastian Oppermann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Java-WebSocket (`org.java-websocket:Java-WebSocket:1.6.0`) — MIT License

```text
Copyright (c) 2010-2020 Nathan Rajlich

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### SLF4J (`org.slf4j:slf4j-api:2.0.13`, `org.slf4j:slf4j-jdk14:2.0.13`) — MIT License

```text
Copyright (c) 2004-2022 QOS.ch Sarl (Switzerland)
All rights reserved.

Permission is hereby granted, free  of charge, to any person obtaining
a  copy  of this  software  and  associated  documentation files  (the
"Software"), to  deal in  the Software without  restriction, including
without limitation  the rights to  use, copy, modify,  merge, publish,
distribute,  sublicense, and/or sell  copies of  the Software,  and to
permit persons to whom the Software  is furnished to do so, subject to
the following conditions:

The  above  copyright  notice  and  this permission  notice  shall  be
included in all copies or substantial portions of the Software.

THE  SOFTWARE IS  PROVIDED  "AS  IS", WITHOUT  WARRANTY  OF ANY  KIND,
EXPRESS OR  IMPLIED, INCLUDING  BUT NOT LIMITED  TO THE  WARRANTIES OF
MERCHANTABILITY,    FITNESS    FOR    A   PARTICULAR    PURPOSE    AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE,  ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 3. Vendored Browser Assets (`webpage/lib/`)

### opus-recorder v8.0.5 (+ libopus & Speex) — MIT / BSD-3-Clause

Files:
- `webpage/lib/encoderWorker.min.js`
- `webpage/lib/decoderWorker.min.js`
- `webpage/lib/decoderWorker.min.wasm`

Full license texts and copyright notices are preserved verbatim in
[webpage/lib/opus-recorder-LICENSE.md](webpage/lib/opus-recorder-LICENSE.md):
- **opus-recorder**: MIT License (Copyright 2013 Matt Diamond; Copyright 2014 Christopher Rudmin)
- **Opus**: BSD-3-Clause License (Copyright 2001–2011 Xiph.Org, Skype Limited, Octasic, et al.)
- **Speex**: BSD-3-Clause License (Copyright 2002–2003 Jean-Marc Valin / Xiph.Org Foundation)

**GPLv3 Section 6 (Corresponding Source) notice:**
The files above are prebuilt/minified outputs from upstream `chris-rudmin/opus-recorder`
tag `v8.0.5` (commit `fdfdadeeb9bc9d045c59dc75ebefed390e4ad6dc`,
<https://github.com/chris-rudmin/opus-recorder/tree/v8.0.5>).
When distributing binary/minified release packages that include `webpage/lib/`,
you must also make the Corresponding Source for `opus-recorder` v8.0.5 (including
its build scripts and bundled `libopus`/`speex` C sources) available alongside the
release (for example, by attaching the `opus-recorder` v8.0.5 source archive to
the same release).

### Pixelify Sans — SIL Open Font License 1.1 (OFL-1.1)

File:
- `webpage/lib/PixelifySans.ttf` (`PixelifySans[wght].ttf` from Google Fonts)

Copyright 2021 The Pixelify Sans Project Authors
(<https://github.com/eifetx/Pixelify-Sans>).

Full license text is preserved verbatim in
[webpage/lib/PixelifySans-LICENSE.txt](webpage/lib/PixelifySans-LICENSE.txt).
Per SIL OFL 1.1 Condition 5, the font software itself remains licensed exclusively
under the SIL Open Font License 1.1 and is **not** relicensed under GPLv3.

---

## 4. Runtime / Provided Dependencies (Not Bundled in the Plugin JAR)

The following libraries are `compileOnly` or downloaded at runtime by the server
platform and are not redistributed inside the compiled plugin JAR:

- **Kotlin Standard Library & kotlinx.coroutines** — Apache License 2.0
- **Kyori Adventure (`adventure-text-minimessage`, `adventure-text-serializer-gson`, `adventure-text-serializer-legacy`)** — MIT License (bundled by Paper/Folia; loaded via `plugin.yml` `libraries` on Spigot)
- **Paper API** — GNU General Public License v3.0 (with Kyori Adventure and Mojang Brigadier under MIT)
- **Plasmo Voice API / Protocol** (`su.plo.voice.*`) — GNU Lesser General Public License v3.0 (LGPL-3.0)
- **Plasmo SLib** (`su.plo.slib:api-server`) — MIT License
- **Simple Voice Chat** (`de.maxhenkel.voicechat:voicechat-api` / runtime `voicechat` plugin) — Main plugin is All Rights Reserved (API templates under MIT); linking is explicitly permitted under [LICENSE-EXCEPTION](LICENSE-EXCEPTION)

---

## 5. Adapted Utilities

- **YAML Config Updater (`io.pfaumc.voicebridge.config.updater.*`)** — Adapted from [NMinimap](https://github.com/NezuShin/NMinimap) (GPLv3), originally derived from `tchristofferson/Config-Updater` (MIT License).
- **Platform, Scheduler & Message Utilities (`PlatformUtil`, `SchedulerUtil`, `Message`)** — Adapted from [NMinimap](https://github.com/NezuShin/NMinimap) (GPLv3).
