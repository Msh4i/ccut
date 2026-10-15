# Third-party notices

Ccut bundles third-party material. This file lists it with the copyright notice and licence each author requires. Where a component ships its own licence text inside the application, the path of that file is given (paths are relative to the repository root; in the packaged desktop app the same files are under `resources/web/apps/web/public/`).

This file is maintained by hand. `apps/web/src/__tests__/third-party-notices.test.ts` fails when a bundled font family or a shipped asset folder has no entry here, and pins the licence texts below.

## Ccut's own code

Ccut is built on OpenCut. Its own source code is licensed as stated in the `LICENSE` file at the repository root: `Copyright 2025-2026 OpenCut`, under a permission notice that allows use, copying, modification, merging, publication, distribution, sublicensing and sale, provided the copyright and permission notice are included in all copies or substantial portions of the software. Read that file for the full terms.

## 1. Fonts

80 font families are bundled for offline use in `apps/web/public/fonts/files/<id>/`: 77 under the SIL Open Font License 1.1 (OFL-1.1) and 3 under the Apache License 2.0 (Luckiest Guy, Special Elite, Yellowtail). The files come unmodified from the `@fontsource/<id>` npm packages (version shown); they were not re-subsetted. Each family's own licence text is the `LICENSE` file in its folder (the path ends every line below). Bundling a font in the application does not place the application under the OFL, and exporting a video with the font embedded needs no further notice.

Lines marked `[LICENSE has no copyright line; font file says:]` have no copyright line in the package's `LICENSE`; the line given is the copyright record from the font file itself (name table, nameID 0). The `LICENSE` of Black Ops One names "PinyonScript Project Authors"; it is the package's file, unmodified, and was not checked against the font's upstream project.

- Inter 5.3.0: OFL-1.1. Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) (licence text: `apps/web/public/fonts/files/inter/LICENSE`)
- Roboto 5.3.0: OFL-1.1. Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic) (licence text: `apps/web/public/fonts/files/roboto/LICENSE`)
- Open Sans 5.3.0: OFL-1.1. Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans) (licence text: `apps/web/public/fonts/files/open-sans/LICENSE`)
- Montserrat 5.3.0: OFL-1.1. Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat) (licence text: `apps/web/public/fonts/files/montserrat/LICENSE`)
- Poppins 5.3.0: OFL-1.1. Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins) (licence text: `apps/web/public/fonts/files/poppins/LICENSE`)
- Nunito 5.3.0: OFL-1.1. Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito) (licence text: `apps/web/public/fonts/files/nunito/LICENSE`)
- Raleway 5.3.0: OFL-1.1. Copyright 2010 The Raleway Project Authors (impallari@gmail.com), with Reserved Font Name "Raleway". (licence text: `apps/web/public/fonts/files/raleway/LICENSE`)
- Rubik 5.3.0: OFL-1.1. Copyright 2015 The Rubik Project Authors (https://github.com/googlefonts/rubik) (licence text: `apps/web/public/fonts/files/rubik/LICENSE`)
- Barlow 5.3.0: OFL-1.1. Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow) (licence text: `apps/web/public/fonts/files/barlow/LICENSE`)
- Oswald 5.3.0: OFL-1.1. Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont) (licence text: `apps/web/public/fonts/files/oswald/LICENSE`)
- Work Sans 5.3.0: OFL-1.1. Copyright 2019 The Work Sans Project Authors (https://github.com/weiweihuanghuang/Work-Sans) (licence text: `apps/web/public/fonts/files/work-sans/LICENSE`)
- DM Sans 5.3.0: OFL-1.1. Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts) (licence text: `apps/web/public/fonts/files/dm-sans/LICENSE`)
- Manrope 5.3.0: OFL-1.1. Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope) (licence text: `apps/web/public/fonts/files/manrope/LICENSE`)
- Outfit 5.3.0: OFL-1.1. Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts) (licence text: `apps/web/public/fonts/files/outfit/LICENSE`)
- Source Sans 3 5.3.0: OFL-1.1. [LICENSE has no copyright line; font file says:] © 2023 Adobe (http://www.adobe.com/), with Reserved Font Name ‘Source’ (licence text: `apps/web/public/fonts/files/source-sans-3/LICENSE`)
- Noto Sans 5.3.0: OFL-1.1. Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) (licence text: `apps/web/public/fonts/files/noto-sans/LICENSE`)
- Fira Sans 5.3.0: OFL-1.1. [LICENSE has no copyright line; font file says:] Digitized data copyright 2012-2016, The Mozilla Foundation and Telefonica S.A. (licence text: `apps/web/public/fonts/files/fira-sans/LICENSE`)
- Josefin Sans 5.3.0: OFL-1.1. Copyright 2010 The Josefin Sans Project Authors (https://github.com/ThomasJockin/JosefinSansFont-master), with Reserved Font Name "Josefin Sans". (licence text: `apps/web/public/fonts/files/josefin-sans/LICENSE`)
- Quicksand 5.3.0: OFL-1.1. Copyright 2019 The Quicksand Project Authors (https://github.com/andrew-paglinawan/QuicksandFamily.git), with Reserved Font Name "Quicksand" (licence text: `apps/web/public/fonts/files/quicksand/LICENSE`)
- Mulish 5.3.0: OFL-1.1. Copyright 2016 The Mulish Project Authors (https://github.com/googlefonts/mulish) (licence text: `apps/web/public/fonts/files/mulish/LICENSE`)
- Karla 5.3.0: OFL-1.1. Copyright 2019 The Karla Project Authors (https://github.com/googlefonts/karla) (licence text: `apps/web/public/fonts/files/karla/LICENSE`)
- Space Grotesk 5.3.0: OFL-1.1. Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) (licence text: `apps/web/public/fonts/files/space-grotesk/LICENSE`)
- Archivo 5.3.0: OFL-1.1. Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) (licence text: `apps/web/public/fonts/files/archivo/LICENSE`)
- Bebas Neue 5.3.0: OFL-1.1. Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue) (licence text: `apps/web/public/fonts/files/bebas-neue/LICENSE`)
- Anton 5.3.0: OFL-1.1. Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git) (licence text: `apps/web/public/fonts/files/anton/LICENSE`)
- Bangers 5.3.0: OFL-1.1. Copyright 2010 The Bangers Project Authors (https://github.com/googlefonts/bangers) (licence text: `apps/web/public/fonts/files/bangers/LICENSE`)
- Lobster 5.3.0: OFL-1.1. Copyright 2010 The Lobster Project Authors (https://github.com/impallari/The-Lobster-Font), with Reserved Font Name "Lobster". (licence text: `apps/web/public/fonts/files/lobster/LICENSE`)
- Righteous 5.3.0: OFL-1.1. Copyright (c) 2011 by Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Name "Righteous" (licence text: `apps/web/public/fonts/files/righteous/LICENSE`)
- Bungee 5.3.0: OFL-1.1. Copyright 2023 The Bungee Project Authors (https://github.com/djrrb/Bungee) (licence text: `apps/web/public/fonts/files/bungee/LICENSE`)
- Press Start 2P 5.3.0: OFL-1.1. Copyright 2012 The Press Start 2P Project Authors (cody@zone38.net), with Reserved Font Name "Press Start 2P" (licence text: `apps/web/public/fonts/files/press-start-2p/LICENSE`)
- Black Ops One 5.3.0: OFL-1.1. Copyright 2022 The PinyonScript Project Authors (https://github.com/SorkinType/Black-Ops) (licence text: `apps/web/public/fonts/files/black-ops-one/LICENSE`)
- Staatliches 5.3.0: OFL-1.1. Copyright 2018 The Staatliches Project Authors (https://github.com/googlefonts/staatliches) (licence text: `apps/web/public/fonts/files/staatliches/LICENSE`)
- Alfa Slab One 5.3.0: OFL-1.1. Copyright 2016 The Alfa Slab One Project Authors (http://www.jmsole.cl | info@jmsole.cl), with Reserved Font Name "Alfa Slab". (licence text: `apps/web/public/fonts/files/alfa-slab-one/LICENSE`)
- Abril Fatface 5.3.0: OFL-1.1. Copyright (c) 2011, Copyright (c) 2011, TypeTogether (www.type-together.com info@type-together.com), with Reserved Font Names "Abril" and "Abril Fatface" (licence text: `apps/web/public/fonts/files/abril-fatface/LICENSE`)
- Baloo 2 5.3.0: OFL-1.1. Copyright 2019 The Baloo 2 Project Authors (https://github.com/EkType/Baloo2) (licence text: `apps/web/public/fonts/files/baloo-2/LICENSE`)
- Shrikhand 5.3.0: OFL-1.1. Copyright (c) 2015 Jonny Pinhorn (jonpinhorn.typedesign@gmail.com) (licence text: `apps/web/public/fonts/files/shrikhand/LICENSE`)
- Monoton 5.3.0: OFL-1.1. Copyright (c) 2011, Vernon Adams (vern@newtypography.co.uk) with Reserved Font Name 'Monoton'. All rights reserved. (licence text: `apps/web/public/fonts/files/monoton/LICENSE`)
- Audiowide 5.3.0: OFL-1.1. Copyright (c) 2012 by Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Name "Audiowide" (licence text: `apps/web/public/fonts/files/audiowide/LICENSE`)
- Archivo Black 5.3.0: OFL-1.1. Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack) (licence text: `apps/web/public/fonts/files/archivo-black/LICENSE`)
- Russo One 5.3.0: OFL-1.1. Copyright (c) 2011-2012, Jovanny Lemonad (lemonad@jovanny.ru), with Reserved Font Name "Russo" (licence text: `apps/web/public/fonts/files/russo-one/LICENSE`)
- Paytone One 5.3.0: OFL-1.1. Copyright 2011 The Paytone Project Authors (https://github.com/googlefonts/paytoneFont) (licence text: `apps/web/public/fonts/files/paytone-one/LICENSE`)
- League Gothic 5.3.0: OFL-1.1. Copyright 2020 The League Gothic Project Authors (https://github.com/theleagueof/league-gothic) (licence text: `apps/web/public/fonts/files/league-gothic/LICENSE`)
- Teko 5.3.0: OFL-1.1. Copyright 2023 The Teko Project Authors (https://www.github.com/googlefonts/teko) (licence text: `apps/web/public/fonts/files/teko/LICENSE`)
- Comfortaa 5.3.0: OFL-1.1. Copyright 2011 The Comfortaa Project Authors (https://github.com/alexeiva/comfortaa), with Reserved Font Name "Comfortaa". (licence text: `apps/web/public/fonts/files/comfortaa/LICENSE`)
- Sigmar One 5.3.0: OFL-1.1. Copyright 2011 The Sigmar One Project Authors (contact@sansoxygen.com) (licence text: `apps/web/public/fonts/files/sigmar-one/LICENSE`)
- Tilt Warp 5.3.0: OFL-1.1. Copyright 2019 The Tilt Project Authors (https://github.com/googlefonts/Tilt-Fonts) (licence text: `apps/web/public/fonts/files/tilt-warp/LICENSE`)
- Rubik Bubbles 5.3.0: OFL-1.1. Copyright 2020 The Rubik Filtered Project Authors (https://github.com/NaN-xyz/Rubik-Filtered) (licence text: `apps/web/public/fonts/files/rubik-bubbles/LICENSE`)
- Gabarito 5.3.0: OFL-1.1. Copyright 2023 The Gabarito Project Authors (https://github.com/naipefoundry/gabarito) (licence text: `apps/web/public/fonts/files/gabarito/LICENSE`)
- Playfair Display 5.3.0: OFL-1.1. Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display". (licence text: `apps/web/public/fonts/files/playfair-display/LICENSE`)
- Merriweather 5.3.0: OFL-1.1. Copyright 2024 The Merriweather Project Authors (https://github.com/EbenSorkin/Merriweather4) with Reserved Font Name "Merriweather". (licence text: `apps/web/public/fonts/files/merriweather/LICENSE`)
- Lora 5.3.0: OFL-1.1. Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), with Reserved Font Name "Lora". (licence text: `apps/web/public/fonts/files/lora/LICENSE`)
- Cinzel 5.3.0: OFL-1.1. Copyright 2020 The Cinzel Project Authors (https://github.com/NDISCOVER/Cinzel) (licence text: `apps/web/public/fonts/files/cinzel/LICENSE`)
- DM Serif Display 5.3.0: OFL-1.1. Copyright 2014 - 2017 Adobe Systems Incorporated (http://www.adobe.com/), with Reserved Font Name 'Source'. Copyright 2019 Google LLC. (licence text: `apps/web/public/fonts/files/dm-serif-display/LICENSE`)
- Cormorant Garamond 5.3.0: OFL-1.1. Copyright 2015 The Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) (licence text: `apps/web/public/fonts/files/cormorant-garamond/LICENSE`)
- EB Garamond 5.3.0: OFL-1.1. Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12) (licence text: `apps/web/public/fonts/files/eb-garamond/LICENSE`)
- Libre Baskerville 5.3.0: OFL-1.1. Copyright 2012 The Libre Baskerville Project Authors (https://github.com/impallari/Libre-Baskerville) (licence text: `apps/web/public/fonts/files/libre-baskerville/LICENSE`)
- Bitter 5.3.0: OFL-1.1. Copyright 2011 The Bitter Project Authors (https://github.com/solmatas/BitterPro) (licence text: `apps/web/public/fonts/files/bitter/LICENSE`)
- Pacifico 5.3.0: OFL-1.1. Copyright 2018 The Pacifico Project Authors (https://github.com/googlefonts/Pacifico) (licence text: `apps/web/public/fonts/files/pacifico/LICENSE`)
- Caveat 5.3.0: OFL-1.1. Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat) (licence text: `apps/web/public/fonts/files/caveat/LICENSE`)
- Dancing Script 5.3.0: OFL-1.1. Copyright 2016 The Dancing Script Project Authors (https://github.com/googlefonts/DancingScript), with Reserved Font Name 'Dancing Script'. (licence text: `apps/web/public/fonts/files/dancing-script/LICENSE`)
- Great Vibes 5.3.0: OFL-1.1. Copyright 2010 The Great Vibes Pro Project Authors (https://github.com/googlefonts/great-vibes) (licence text: `apps/web/public/fonts/files/great-vibes/LICENSE`)
- Indie Flower 5.3.0: OFL-1.1. Copyright 2010 The Indie Flower Authors (kimberlygeswein.com) (licence text: `apps/web/public/fonts/files/indie-flower/LICENSE`)
- Shadows Into Light 5.3.0: OFL-1.1. Copyright (c) 2010, Kimberly Geswein (kimberlygeswein.com kimberlygeswein@gmail.com) (licence text: `apps/web/public/fonts/files/shadows-into-light/LICENSE`)
- Patrick Hand 5.3.0: OFL-1.1. Copyright (c) 2010-2012 Patrick Wagesreiter (mail@patrickwagesreiter.at) (licence text: `apps/web/public/fonts/files/patrick-hand/LICENSE`)
- Kalam 5.3.0: OFL-1.1. Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com) (licence text: `apps/web/public/fonts/files/kalam/LICENSE`)
- Courgette 5.3.0: OFL-1.1. Copyright (c) 2012, Sorkin Type Co (www.sorkintype.com eben@eyebytes.com) with Reserved Font Name "Courgette". (licence text: `apps/web/public/fonts/files/courgette/LICENSE`)
- Sacramento 5.3.0: OFL-1.1. Copyright (c) 2012 by Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Name 'Sacramento' (licence text: `apps/web/public/fonts/files/sacramento/LICENSE`)
- Amatic SC 5.3.0: OFL-1.1. Copyright 2015 The Amatic SC Project Authors (https://github.com/googlefonts/AmaticSC) (licence text: `apps/web/public/fonts/files/amatic-sc/LICENSE`)
- Gloria Hallelujah 5.3.0: OFL-1.1. Copyright (c) 2010, Kimberly Geswein (kimberlygeswein.com kimberlygeswein@gmail.com) (licence text: `apps/web/public/fonts/files/gloria-hallelujah/LICENSE`)
- Parisienne 5.3.0: OFL-1.1. Copyright (c) 2012 by Brian J. Bonislawsky DBA Astigmatic (AOETI) (astigma@astigmatic.com), with Reserved Font Name "Parisienne" (licence text: `apps/web/public/fonts/files/parisienne/LICENSE`)
- Kaushan Script 5.3.0: OFL-1.1. Copyright (c) 2011, Pablo Impallari (www.impallari.com|impallari@gmail.com), Copyright (c) 2011, Igino Marini. (www.ikern.com|mail@iginomarini.com), with Reserved Font Name Kaushan Script. (licence text: `apps/web/public/fonts/files/kaushan-script/LICENSE`)
- Pangolin 5.3.0: OFL-1.1. Copyright 2016 The Pangolin Project Authors (https://github.com/googlefonts/pangolin) (licence text: `apps/web/public/fonts/files/pangolin/LICENSE`)
- Caveat Brush 5.3.0: OFL-1.1. Copyright 2015 Google Inc. All Rights Reserved. (licence text: `apps/web/public/fonts/files/caveat-brush/LICENSE`)
- JetBrains Mono 5.3.0: OFL-1.1. Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) (licence text: `apps/web/public/fonts/files/jetbrains-mono/LICENSE`)
- Fira Code 5.3.0: OFL-1.1. Copyright 2014-2020 The Fira Code Project Authors (https://github.com/tonsky/FiraCode) (licence text: `apps/web/public/fonts/files/fira-code/LICENSE`)
- Space Mono 5.3.0: OFL-1.1. Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono) (licence text: `apps/web/public/fonts/files/space-mono/LICENSE`)
- Roboto Mono 5.3.0: OFL-1.1. Copyright 2015 The Roboto Mono Project Authors (https://github.com/googlefonts/robotomono) (licence text: `apps/web/public/fonts/files/roboto-mono/LICENSE`)
- Luckiest Guy 5.3.0: Apache-2.0. [LICENSE has no copyright line; font file says:] Copyright (c) 2010 by Brian J. Bonislawsky DBA Astigmatic (AOETI). All rights reserved. Available under the Apache 2.0 licence. http://www.apache.org/licenses/LICENSE-2.0.html (licence text: `apps/web/public/fonts/files/luckiest-guy/LICENSE`)
- Yellowtail 5.3.0: Apache-2.0. [LICENSE has no copyright line; font file says:] Copyright (c) 2011 by Brian J. Bonislawsky DBA Astigmatic (AOETI). All rights reserved. Available under the Apache 2.0 licence. http://www.apache.org/licenses/LICENSE-2.0.html (licence text: `apps/web/public/fonts/files/yellowtail/LICENSE`)
- Special Elite 5.3.0: Apache-2.0. [LICENSE has no copyright line; font file says:] Copyright (c) 2010 by Brian J. Bonislawsky DBA Astigmatic (AOETI). All rights reserved. Available under the Apache 2.0 licence. http://www.apache.org/licenses/LICENSE-2.0.html (licence text: `apps/web/public/fonts/files/special-elite/LICENSE`)

## 2. Sticker libraries

The sticker picker ships two libraries (emoji and icons), a flag set, and Turkish emoji keywords. All are stored as files under `apps/web/public/` and work offline. They are regenerated by `apps/web/scripts/generate-emoji.ts` and `apps/web/scripts/generate-icons.ts`.

- **Fluent Emoji** (Flat style, default skin tone; 1,595 SVG files in `apps/web/public/emoji/fluent-flat/`): Copyright (c) Microsoft Corporation. MIT License. Source: https://github.com/microsoft/fluentui-emoji, commit `1ffb34c752ecf5d402f04cfb4b392c77f57c54bc` (2026-08-24). Modified: the root `<svg>` `width` and `height` were set to 512 (they were 32); all paths, colours and gradients are unchanged. The English names and keywords in `apps/web/public/emoji/index.json` come from the project's `metadata.json` files. Licence text: `apps/web/public/emoji/fluent-flat/LICENSE`.
- **Phosphor Icons** (regular and fill weights; 1,433 icons, 2,866 SVG files in `apps/web/public/icons/phosphor/`): Copyright (c) 2023 Phosphor Icons. MIT License. Source: npm package `@phosphor-icons/core` 2.1.1 (https://github.com/phosphor-icons/core). Modified: `fill="currentColor"` on the root element was replaced by `fill="#FFFFFF"` and `width`/`height` were set to 512. The 79 company and product logos in the set (its "brands" category and `*-logo` names) are not included. Licence text: `apps/web/public/icons/phosphor/LICENSE`.
- **Unicode CLDR annotations** (the Turkish emoji names and search keywords, merged into `apps/web/public/emoji/index.json`): Copyright © 2004-2026 Unicode, Inc. Unicode License V3 (SPDX: Unicode-3.0). Source: https://github.com/unicode-org/cldr, tag `release-48-2`, commit `11299982335beb974c1c63c45265184e759c0f41` (2026-03-16), files `common/annotations/tr.xml` and `common/annotationsDerived/tr.xml`. Modified: the two files were merged with the English keywords, duplicates were removed, and the data was reduced to the fields the picker searches. The notice below is the CLDR repository's `LICENSE` file; it ships with the data as `apps/web/public/emoji/UNICODE-LICENSE.txt`.
- **flag-icons** (271 country flags in `apps/web/public/flags/`): Copyright (c) 2013 Panayiotis Lipiridis. MIT License. Source: https://github.com/lipis/flag-icons, version 7.5.0, commit `7aa5b2bdddd570ece62c812c0cb588ccdc099e2e`; the `flags/4x3/` files, not modified. Licence text: `apps/web/public/flags/LICENSE`.

### Licence texts, verbatim

#### Fluent Emoji: `apps/web/public/emoji/fluent-flat/LICENSE`

```text
    MIT License

    Copyright (c) Microsoft Corporation.

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
    SOFTWARE
```

#### Phosphor Icons: `apps/web/public/icons/phosphor/LICENSE`

```text
MIT License

Copyright (c) 2023 Phosphor Icons

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

#### flag-icons: `apps/web/public/flags/LICENSE`

```text
The MIT License (MIT)

Copyright (c) 2013 Panayiotis Lipiridis

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

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

#### Unicode License V3 (CLDR): `apps/web/public/emoji/UNICODE-LICENSE.txt`

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 2004-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

SPDX-License-Identifier: Unicode-3.0
```

## 3. npm dependencies

Ccut's JavaScript and Rust dependencies keep their own licences. They are not reproduced here: each npm package carries its licence file inside its published package (`node_modules/<package>/LICENSE`), and the direct dependencies are listed with version ranges in `apps/web/package.json` and `package.json`. The installed tree, including transitive packages, is printed by `bun pm ls --all`. Among the runtime dependencies are `lucide-react` (ISC licence), which draws the editor's interface icons, `@hugeicons/react` and `@hugeicons/core-free-icons`, Radix UI, React and Next.js. The WebAssembly compositor is the published `opencut-wasm` package. Anyone redistributing Ccut should collect the licence files of the dependencies that end up in the build they ship. Two packages are the exception: they are covered, with their licence texts, in section 4, because compiled FFmpeg code ships inside one of them.

## 4. WebAssembly encoders

Exporting a project with audio as MP4 encodes the audio as AAC-LC with an encoder that runs as WebAssembly inside the application's window. Two npm packages provide it. Ccut installs them unmodified from npm and pins both to the exact version below in `apps/web/package.json` (no version range). The encoder is imported with a dynamic `import()` in one module, `apps/web/src/services/renderer/aac-encoder.ts`, and only when such an export starts; a test enforces that no other file imports it. Exports to WebM do not use it.

- **mediabunny** 1.41.0 (muxing and encoding library used for every export): the header of its published bundle reads "Copyright (c) 2026-present, Vanilagy and contributors". Mozilla Public License 2.0 (SPDX: MPL-2.0). Source code: https://github.com/Vanilagy/mediabunny, tag `v1.41.0` (commit `b285360563b754546cbfb7bbcf853f107e1dd3b9`); the `gitHead` that npm records for the published package is `0d5bf18864438ef4db9ff76398c3dfd02b3d19b9`, a commit by github-actions[bot] with the message "Merge main into release for tag v1.41.0" whose parents are the release branch and the tag commit above. npm lists a SLSA provenance attestation for the package. Not modified. In the desktop app it also ships, unmodified, as the package's own CommonJS bundle (`dist/bundles/mediabunny.cjs`, copied by `apps/electron/bundle.js` to `resources/app.asar.unpacked/vendor/mediabunny.cjs`), which the main process uses to combine a downloaded video-only stream and audio-only stream into one MP4 without re-encoding ("Import from link"). Licence text: `node_modules/mediabunny/LICENSE`, quoted below.
- **@mediabunny/aac-encoder** 1.41.0 (registers an AAC encoder with mediabunny): same copyright header, MPL-2.0, same repository, directory `packages/aac-encoder`, same commits as above; npm lists a SLSA provenance attestation for it as well. Not modified. Licence text: `node_modules/@mediabunny/aac-encoder/LICENSE`, byte-identical to mediabunny's and quoted once below.
- **FFmpeg libavcodec** (its native AAC encoder, compiled to WebAssembly and embedded in the `@mediabunny/aac-encoder` package): copyright the FFmpeg developers; the individual copyright lines are in the FFmpeg source files the binary names (`libavcodec/aacenc.c`, `libavcodec/aaccoder.c` and others). Licence: GNU Lesser General Public License version 2.1 or later (SPDX: LGPL-2.1-or-later), quoted below. Source code: https://github.com/FFmpeg/FFmpeg (https://ffmpeg.org). What is established, and what is not:
  - Version. The embedded binary contains the identification string `Lavc62.23.103` (libavcodec 62.23.103). In FFmpeg's `libavcodec/version.h` tag n8.0 is 62.11.100 and tag n8.1 is 62.28.100, so this is an unreleased snapshot between those two tags. The package does not say which FFmpeg commit it was built from, so the exact source revision is `?`. The licence text below is from the n8.0 tag.
  - Licence of this build. The package's README gives the build recipe: FFmpeg configured with `--disable-all --disable-everything --disable-autodetect --enable-avcodec --enable-encoder=aac` (plus further `--disable-*` options and the Emscripten cross-compilation flags), compiled with Emscripten and linked with `-s SINGLE_FILE=1`. The recipe has no `--enable-gpl`, `--enable-version3` or `--enable-nonfree`. FFmpeg's own licence statement (https://github.com/FFmpeg/FFmpeg/blob/n8.0/LICENSE.md) says that in that case "the LGPL v2.1+ applies to FFmpeg" and that it becomes GPL only with `--enable-gpl`. The LGPL-2.1-or-later reading is therefore Ccut's reading of that recipe: neither the package nor the binary states the licence of the wasm itself (the binary was searched for one and carries no licence string).
  - Unmodified; to replace it, rebuild from source. Ccut changes neither FFmpeg nor the package. The package does not ship a separate `.wasm` file: `SINGLE_FILE=1` inlines the wasm into the package's JavaScript bundle (`dist/bundles/mediabunny-aac-encoder.mjs`, 997,184 bytes in 1.41.0), and in a built Ccut that bundle is part of a chunk generated by the web build, so it is not a file that can be swapped in the installed application. To use a different build of the encoder, install another version of `@mediabunny/aac-encoder`, or a build of your own made with the recipe in that package's README, and rebuild Ccut from this repository. Only `aac-encoder.ts` and mediabunny's registration call touch the encoder. This file does not claim that this satisfies every condition the LGPL sets for distributing the binary.
  - Other components in the build. The recipe compiles with Emscripten, whose runtime code is added to the package's JavaScript (Emscripten is available under the MIT and the University of Illinois/NCSA licence); the compiled code may contain parts of a C library derived from musl (MIT); and FFmpeg itself has some files under MIT/X11/BSD-style licences (see its LICENSE.md). Which of these are in the binary, and their copyright notices, have not been researched (`?`).
- AAC patents. This file neither grants nor documents any patent licence for the AAC format. Whether distributing an AAC encoder needs one has not been researched (`?`). This file is not legal advice.

### Licence texts, verbatim

#### Mozilla Public License 2.0: `node_modules/mediabunny/LICENSE` and `node_modules/@mediabunny/aac-encoder/LICENSE`

```text
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

#### GNU Lesser General Public License 2.1: FFmpeg's `COPYING.LGPLv2.1` (tag `n8.0`, https://github.com/FFmpeg/FFmpeg/blob/n8.0/COPYING.LGPLv2.1)

```text
                  GNU LESSER GENERAL PUBLIC LICENSE
                       Version 2.1, February 1999

 Copyright (C) 1991, 1999 Free Software Foundation, Inc.
 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

[This is the first released version of the Lesser GPL.  It also counts
 as the successor of the GNU Library Public License, version 2, hence
 the version number 2.1.]

                            Preamble

  The licenses for most software are designed to take away your
freedom to share and change it.  By contrast, the GNU General Public
Licenses are intended to guarantee your freedom to share and change
free software--to make sure the software is free for all its users.

  This license, the Lesser General Public License, applies to some
specially designated software packages--typically libraries--of the
Free Software Foundation and other authors who decide to use it.  You
can use it too, but we suggest you first think carefully about whether
this license or the ordinary General Public License is the better
strategy to use in any particular case, based on the explanations below.

  When we speak of free software, we are referring to freedom of use,
not price.  Our General Public Licenses are designed to make sure that
you have the freedom to distribute copies of free software (and charge
for this service if you wish); that you receive source code or can get
it if you want it; that you can change the software and use pieces of
it in new free programs; and that you are informed that you can do
these things.

  To protect your rights, we need to make restrictions that forbid
distributors to deny you these rights or to ask you to surrender these
rights.  These restrictions translate to certain responsibilities for
you if you distribute copies of the library or if you modify it.

  For example, if you distribute copies of the library, whether gratis
or for a fee, you must give the recipients all the rights that we gave
you.  You must make sure that they, too, receive or can get the source
code.  If you link other code with the library, you must provide
complete object files to the recipients, so that they can relink them
with the library after making changes to the library and recompiling
it.  And you must show them these terms so they know their rights.

  We protect your rights with a two-step method: (1) we copyright the
library, and (2) we offer you this license, which gives you legal
permission to copy, distribute and/or modify the library.

  To protect each distributor, we want to make it very clear that
there is no warranty for the free library.  Also, if the library is
modified by someone else and passed on, the recipients should know
that what they have is not the original version, so that the original
author's reputation will not be affected by problems that might be
introduced by others.

  Finally, software patents pose a constant threat to the existence of
any free program.  We wish to make sure that a company cannot
effectively restrict the users of a free program by obtaining a
restrictive license from a patent holder.  Therefore, we insist that
any patent license obtained for a version of the library must be
consistent with the full freedom of use specified in this license.

  Most GNU software, including some libraries, is covered by the
ordinary GNU General Public License.  This license, the GNU Lesser
General Public License, applies to certain designated libraries, and
is quite different from the ordinary General Public License.  We use
this license for certain libraries in order to permit linking those
libraries into non-free programs.

  When a program is linked with a library, whether statically or using
a shared library, the combination of the two is legally speaking a
combined work, a derivative of the original library.  The ordinary
General Public License therefore permits such linking only if the
entire combination fits its criteria of freedom.  The Lesser General
Public License permits more lax criteria for linking other code with
the library.

  We call this license the "Lesser" General Public License because it
does Less to protect the user's freedom than the ordinary General
Public License.  It also provides other free software developers Less
of an advantage over competing non-free programs.  These disadvantages
are the reason we use the ordinary General Public License for many
libraries.  However, the Lesser license provides advantages in certain
special circumstances.

  For example, on rare occasions, there may be a special need to
encourage the widest possible use of a certain library, so that it becomes
a de-facto standard.  To achieve this, non-free programs must be
allowed to use the library.  A more frequent case is that a free
library does the same job as widely used non-free libraries.  In this
case, there is little to gain by limiting the free library to free
software only, so we use the Lesser General Public License.

  In other cases, permission to use a particular library in non-free
programs enables a greater number of people to use a large body of
free software.  For example, permission to use the GNU C Library in
non-free programs enables many more people to use the whole GNU
operating system, as well as its variant, the GNU/Linux operating
system.

  Although the Lesser General Public License is Less protective of the
users' freedom, it does ensure that the user of a program that is
linked with the Library has the freedom and the wherewithal to run
that program using a modified version of the Library.

  The precise terms and conditions for copying, distribution and
modification follow.  Pay close attention to the difference between a
"work based on the library" and a "work that uses the library".  The
former contains code derived from the library, whereas the latter must
be combined with the library in order to run.

                  GNU LESSER GENERAL PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. This License Agreement applies to any software library or other
program which contains a notice placed by the copyright holder or
other authorized party saying it may be distributed under the terms of
this Lesser General Public License (also called "this License").
Each licensee is addressed as "you".

  A "library" means a collection of software functions and/or data
prepared so as to be conveniently linked with application programs
(which use some of those functions and data) to form executables.

  The "Library", below, refers to any such software library or work
which has been distributed under these terms.  A "work based on the
Library" means either the Library or any derivative work under
copyright law: that is to say, a work containing the Library or a
portion of it, either verbatim or with modifications and/or translated
straightforwardly into another language.  (Hereinafter, translation is
included without limitation in the term "modification".)

  "Source code" for a work means the preferred form of the work for
making modifications to it.  For a library, complete source code means
all the source code for all modules it contains, plus any associated
interface definition files, plus the scripts used to control compilation
and installation of the library.

  Activities other than copying, distribution and modification are not
covered by this License; they are outside its scope.  The act of
running a program using the Library is not restricted, and output from
such a program is covered only if its contents constitute a work based
on the Library (independent of the use of the Library in a tool for
writing it).  Whether that is true depends on what the Library does
and what the program that uses the Library does.

  1. You may copy and distribute verbatim copies of the Library's
complete source code as you receive it, in any medium, provided that
you conspicuously and appropriately publish on each copy an
appropriate copyright notice and disclaimer of warranty; keep intact
all the notices that refer to this License and to the absence of any
warranty; and distribute a copy of this License along with the
Library.

  You may charge a fee for the physical act of transferring a copy,
and you may at your option offer warranty protection in exchange for a
fee.

  2. You may modify your copy or copies of the Library or any portion
of it, thus forming a work based on the Library, and copy and
distribute such modifications or work under the terms of Section 1
above, provided that you also meet all of these conditions:

    a) The modified work must itself be a software library.

    b) You must cause the files modified to carry prominent notices
    stating that you changed the files and the date of any change.

    c) You must cause the whole of the work to be licensed at no
    charge to all third parties under the terms of this License.

    d) If a facility in the modified Library refers to a function or a
    table of data to be supplied by an application program that uses
    the facility, other than as an argument passed when the facility
    is invoked, then you must make a good faith effort to ensure that,
    in the event an application does not supply such function or
    table, the facility still operates, and performs whatever part of
    its purpose remains meaningful.

    (For example, a function in a library to compute square roots has
    a purpose that is entirely well-defined independent of the
    application.  Therefore, Subsection 2d requires that any
    application-supplied function or table used by this function must
    be optional: if the application does not supply it, the square
    root function must still compute square roots.)

These requirements apply to the modified work as a whole.  If
identifiable sections of that work are not derived from the Library,
and can be reasonably considered independent and separate works in
themselves, then this License, and its terms, do not apply to those
sections when you distribute them as separate works.  But when you
distribute the same sections as part of a whole which is a work based
on the Library, the distribution of the whole must be on the terms of
this License, whose permissions for other licensees extend to the
entire whole, and thus to each and every part regardless of who wrote
it.

Thus, it is not the intent of this section to claim rights or contest
your rights to work written entirely by you; rather, the intent is to
exercise the right to control the distribution of derivative or
collective works based on the Library.

In addition, mere aggregation of another work not based on the Library
with the Library (or with a work based on the Library) on a volume of
a storage or distribution medium does not bring the other work under
the scope of this License.

  3. You may opt to apply the terms of the ordinary GNU General Public
License instead of this License to a given copy of the Library.  To do
this, you must alter all the notices that refer to this License, so
that they refer to the ordinary GNU General Public License, version 2,
instead of to this License.  (If a newer version than version 2 of the
ordinary GNU General Public License has appeared, then you can specify
that version instead if you wish.)  Do not make any other change in
these notices.

  Once this change is made in a given copy, it is irreversible for
that copy, so the ordinary GNU General Public License applies to all
subsequent copies and derivative works made from that copy.

  This option is useful when you wish to copy part of the code of
the Library into a program that is not a library.

  4. You may copy and distribute the Library (or a portion or
derivative of it, under Section 2) in object code or executable form
under the terms of Sections 1 and 2 above provided that you accompany
it with the complete corresponding machine-readable source code, which
must be distributed under the terms of Sections 1 and 2 above on a
medium customarily used for software interchange.

  If distribution of object code is made by offering access to copy
from a designated place, then offering equivalent access to copy the
source code from the same place satisfies the requirement to
distribute the source code, even though third parties are not
compelled to copy the source along with the object code.

  5. A program that contains no derivative of any portion of the
Library, but is designed to work with the Library by being compiled or
linked with it, is called a "work that uses the Library".  Such a
work, in isolation, is not a derivative work of the Library, and
therefore falls outside the scope of this License.

  However, linking a "work that uses the Library" with the Library
creates an executable that is a derivative of the Library (because it
contains portions of the Library), rather than a "work that uses the
library".  The executable is therefore covered by this License.
Section 6 states terms for distribution of such executables.

  When a "work that uses the Library" uses material from a header file
that is part of the Library, the object code for the work may be a
derivative work of the Library even though the source code is not.
Whether this is true is especially significant if the work can be
linked without the Library, or if the work is itself a library.  The
threshold for this to be true is not precisely defined by law.

  If such an object file uses only numerical parameters, data
structure layouts and accessors, and small macros and small inline
functions (ten lines or less in length), then the use of the object
file is unrestricted, regardless of whether it is legally a derivative
work.  (Executables containing this object code plus portions of the
Library will still fall under Section 6.)

  Otherwise, if the work is a derivative of the Library, you may
distribute the object code for the work under the terms of Section 6.
Any executables containing that work also fall under Section 6,
whether or not they are linked directly with the Library itself.

  6. As an exception to the Sections above, you may also combine or
link a "work that uses the Library" with the Library to produce a
work containing portions of the Library, and distribute that work
under terms of your choice, provided that the terms permit
modification of the work for the customer's own use and reverse
engineering for debugging such modifications.

  You must give prominent notice with each copy of the work that the
Library is used in it and that the Library and its use are covered by
this License.  You must supply a copy of this License.  If the work
during execution displays copyright notices, you must include the
copyright notice for the Library among them, as well as a reference
directing the user to the copy of this License.  Also, you must do one
of these things:

    a) Accompany the work with the complete corresponding
    machine-readable source code for the Library including whatever
    changes were used in the work (which must be distributed under
    Sections 1 and 2 above); and, if the work is an executable linked
    with the Library, with the complete machine-readable "work that
    uses the Library", as object code and/or source code, so that the
    user can modify the Library and then relink to produce a modified
    executable containing the modified Library.  (It is understood
    that the user who changes the contents of definitions files in the
    Library will not necessarily be able to recompile the application
    to use the modified definitions.)

    b) Use a suitable shared library mechanism for linking with the
    Library.  A suitable mechanism is one that (1) uses at run time a
    copy of the library already present on the user's computer system,
    rather than copying library functions into the executable, and (2)
    will operate properly with a modified version of the library, if
    the user installs one, as long as the modified version is
    interface-compatible with the version that the work was made with.

    c) Accompany the work with a written offer, valid for at
    least three years, to give the same user the materials
    specified in Subsection 6a, above, for a charge no more
    than the cost of performing this distribution.

    d) If distribution of the work is made by offering access to copy
    from a designated place, offer equivalent access to copy the above
    specified materials from the same place.

    e) Verify that the user has already received a copy of these
    materials or that you have already sent this user a copy.

  For an executable, the required form of the "work that uses the
Library" must include any data and utility programs needed for
reproducing the executable from it.  However, as a special exception,
the materials to be distributed need not include anything that is
normally distributed (in either source or binary form) with the major
components (compiler, kernel, and so on) of the operating system on
which the executable runs, unless that component itself accompanies
the executable.

  It may happen that this requirement contradicts the license
restrictions of other proprietary libraries that do not normally
accompany the operating system.  Such a contradiction means you cannot
use both them and the Library together in an executable that you
distribute.

  7. You may place library facilities that are a work based on the
Library side-by-side in a single library together with other library
facilities not covered by this License, and distribute such a combined
library, provided that the separate distribution of the work based on
the Library and of the other library facilities is otherwise
permitted, and provided that you do these two things:

    a) Accompany the combined library with a copy of the same work
    based on the Library, uncombined with any other library
    facilities.  This must be distributed under the terms of the
    Sections above.

    b) Give prominent notice with the combined library of the fact
    that part of it is a work based on the Library, and explaining
    where to find the accompanying uncombined form of the same work.

  8. You may not copy, modify, sublicense, link with, or distribute
the Library except as expressly provided under this License.  Any
attempt otherwise to copy, modify, sublicense, link with, or
distribute the Library is void, and will automatically terminate your
rights under this License.  However, parties who have received copies,
or rights, from you under this License will not have their licenses
terminated so long as such parties remain in full compliance.

  9. You are not required to accept this License, since you have not
signed it.  However, nothing else grants you permission to modify or
distribute the Library or its derivative works.  These actions are
prohibited by law if you do not accept this License.  Therefore, by
modifying or distributing the Library (or any work based on the
Library), you indicate your acceptance of this License to do so, and
all its terms and conditions for copying, distributing or modifying
the Library or works based on it.

  10. Each time you redistribute the Library (or any work based on the
Library), the recipient automatically receives a license from the
original licensor to copy, distribute, link with or modify the Library
subject to these terms and conditions.  You may not impose any further
restrictions on the recipients' exercise of the rights granted herein.
You are not responsible for enforcing compliance by third parties with
this License.

  11. If, as a consequence of a court judgment or allegation of patent
infringement or for any other reason (not limited to patent issues),
conditions are imposed on you (whether by court order, agreement or
otherwise) that contradict the conditions of this License, they do not
excuse you from the conditions of this License.  If you cannot
distribute so as to satisfy simultaneously your obligations under this
License and any other pertinent obligations, then as a consequence you
may not distribute the Library at all.  For example, if a patent
license would not permit royalty-free redistribution of the Library by
all those who receive copies directly or indirectly through you, then
the only way you could satisfy both it and this License would be to
refrain entirely from distribution of the Library.

If any portion of this section is held invalid or unenforceable under any
particular circumstance, the balance of the section is intended to apply,
and the section as a whole is intended to apply in other circumstances.

It is not the purpose of this section to induce you to infringe any
patents or other property right claims or to contest validity of any
such claims; this section has the sole purpose of protecting the
integrity of the free software distribution system which is
implemented by public license practices.  Many people have made
generous contributions to the wide range of software distributed
through that system in reliance on consistent application of that
system; it is up to the author/donor to decide if he or she is willing
to distribute software through any other system and a licensee cannot
impose that choice.

This section is intended to make thoroughly clear what is believed to
be a consequence of the rest of this License.

  12. If the distribution and/or use of the Library is restricted in
certain countries either by patents or by copyrighted interfaces, the
original copyright holder who places the Library under this License may add
an explicit geographical distribution limitation excluding those countries,
so that distribution is permitted only in or among countries not thus
excluded.  In such case, this License incorporates the limitation as if
written in the body of this License.

  13. The Free Software Foundation may publish revised and/or new
versions of the Lesser General Public License from time to time.
Such new versions will be similar in spirit to the present version,
but may differ in detail to address new problems or concerns.

Each version is given a distinguishing version number.  If the Library
specifies a version number of this License which applies to it and
"any later version", you have the option of following the terms and
conditions either of that version or of any later version published by
the Free Software Foundation.  If the Library does not specify a
license version number, you may choose any version ever published by
the Free Software Foundation.

  14. If you wish to incorporate parts of the Library into other free
programs whose distribution conditions are incompatible with these,
write to the author to ask for permission.  For software which is
copyrighted by the Free Software Foundation, write to the Free
Software Foundation; we sometimes make exceptions for this.  Our
decision will be guided by the two goals of preserving the free status
of all derivatives of our free software and of promoting the sharing
and reuse of software generally.

                            NO WARRANTY

  15. BECAUSE THE LIBRARY IS LICENSED FREE OF CHARGE, THERE IS NO
WARRANTY FOR THE LIBRARY, TO THE EXTENT PERMITTED BY APPLICABLE LAW.
EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR
OTHER PARTIES PROVIDE THE LIBRARY "AS IS" WITHOUT WARRANTY OF ANY
KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE
LIBRARY IS WITH YOU.  SHOULD THE LIBRARY PROVE DEFECTIVE, YOU ASSUME
THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

  16. IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN
WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MAY MODIFY
AND/OR REDISTRIBUTE THE LIBRARY AS PERMITTED ABOVE, BE LIABLE TO YOU
FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE
LIBRARY (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING
RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A
FAILURE OF THE LIBRARY TO OPERATE WITH ANY OTHER SOFTWARE), EVEN IF
SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGES.

                     END OF TERMS AND CONDITIONS

           How to Apply These Terms to Your New Libraries

  If you develop a new library, and you want it to be of the greatest
possible use to the public, we recommend making it free software that
everyone can redistribute and change.  You can do so by permitting
redistribution under these terms (or, alternatively, under the terms of the
ordinary General Public License).

  To apply these terms, attach the following notices to the library.  It is
safest to attach them to the start of each source file to most effectively
convey the exclusion of warranty; and each file should have at least the
"copyright" line and a pointer to where the full notice is found.

    <one line to give the library's name and a brief idea of what it does.>
    Copyright (C) <year>  <name of author>

    This library is free software; you can redistribute it and/or
    modify it under the terms of the GNU Lesser General Public
    License as published by the Free Software Foundation; either
    version 2.1 of the License, or (at your option) any later version.

    This library is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
    Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public
    License along with this library; if not, write to the Free Software
    Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA

Also add information on how to contact you by electronic and paper mail.

You should also get your employer (if you work as a programmer) or your
school, if any, to sign a "copyright disclaimer" for the library, if
necessary.  Here is a sample; alter the names:

  Yoyodyne, Inc., hereby disclaims all copyright interest in the
  library `Frob' (a library for tweaking knobs) written by James Random Hacker.

  <signature of Ty Coon>, 1 April 1990
  Ty Coon, President of Vice

That's all there is to it!
```

## Agent integration (MCP server of the desktop app)

The desktop app's main process can serve the Model Context Protocol to agents (off until the owner turns it on). It ships, unmodified, as one esbuild bundle (`vendor/mcp-sdk.cjs`, built by `apps/electron/bundle.js`), containing: `@modelcontextprotocol/sdk` 1.32.1 (MIT, Anthropic and contributors, https://github.com/modelcontextprotocol/typescript-sdk), `zod` 3.25.76 (MIT, Colin McDonnell), `@hono/node-server` 2.1.4 and `hono` 4.13.13 (MIT, Yusuke Wada), `ajv` 8.20.0 and `ajv-formats` 3.0.1 (MIT, Evgeny Poberezkin), `fast-deep-equal` 3.1.3 (MIT), `json-schema-traverse` 1.0.0 (MIT), `content-type` 1.0.5 (MIT), `fast-uri` 3.1.8 (BSD-3-Clause) and `zod-to-json-schema` 3.25.2 (ISC). Each package's licence text is in its `LICENSE` file in `node_modules/<name>/`; MIT and BSD-3-Clause and ISC require that the copyright notice and licence text accompany copies: the bundle is built without licence comments, so the texts are reproduced at the end of this section.

### Licence texts of the packages in the agent integration bundle

The esbuild bundle `vendor/mcp-sdk.cjs` is built without embedded licence comments, so the texts are given here, as the licences require.

#### @modelcontextprotocol/sdk 1.32.1

```
MIT License

Copyright (c) 2024 Anthropic, PBC

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

#### zod 3.25.76

```
MIT License

Copyright (c) 2025 Colin McDonnell

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

#### @hono/node-server 2.1.4

```
MIT License

Copyright (c) 2022 - present, Yusuke Wada and Hono contributors

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

#### hono 4.13.13

```
MIT License

Copyright (c) 2021 - present, Yusuke Wada and Hono contributors

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

#### ajv 8.20.0

```
The MIT License (MIT)

Copyright (c) 2015-2021 Evgeny Poberezkin

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

#### ajv-formats 3.0.1

```
MIT License

Copyright (c) 2020 Evgeny Poberezkin

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

#### fast-deep-equal 3.1.3

```
MIT License

Copyright (c) 2017 Evgeny Poberezkin

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

#### json-schema-traverse 1.0.0

```
MIT License

Copyright (c) 2017 Evgeny Poberezkin

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

#### content-type 1.0.5

```
(The MIT License)

Copyright (c) 2015 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### fast-uri 3.1.8

```
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

#### zod-to-json-schema 3.25.2

```
ISC License

Copyright (c) 2020, Stefan Terdell

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## onnxruntime-web (smart cutout)

The smart cutout runs its model with `onnxruntime-web` 1.22.0-dev.20250409-89f8206ba4 (the same build `@huggingface/transformers` 3.8.1 uses). Its wasm runtime (`public/ort/ort-wasm-simd-threaded.wasm` and `.mjs`, copied from the package by `apps/web/scripts/copy-ort-wasm.mjs`) is a pinned development build. The package states the licence `MIT` in its package.json and ships no licence file; the text below is the project's MIT licence (https://github.com/microsoft/onnxruntime/blob/main/LICENSE). The wasm binary also contains third-party code of onnxruntime itself (listed upstream in https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt, which the npm package does not include): that list has NOT been reproduced here for this development build.

```
MIT License

Copyright (c) Microsoft Corporation

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

## U²-Net-P model (smart cutout, downloaded on request, not bundled)

U²-Net: Qin et al., Apache License 2.0. The `u2netp.onnx` file is the release asset of github.com/danielgatis/rembg (v0.0.0). **The terms under which that particular file may be redistributed are UNCONFIRMED.** Ccut does not ship it: the desktop app downloads it from GitHub only after the owner's click, and the consent dialog says that the terms of the download have not been confirmed.
