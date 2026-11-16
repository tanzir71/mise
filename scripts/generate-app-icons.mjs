import sharp from 'sharp';

// Rasterise the original mark. Maskable artwork stays inside the central safe area.
const directory='apps/web/public',source=`${directory}/mise-mark.svg`;
for(const size of [192,512]) await sharp(source).resize(size,size).png().toFile(`${directory}/icon-${size}.png`);
const mark=await sharp(source).resize(320,320).png().toBuffer();
await sharp({create:{width:512,height:512,channels:4,background:'#141414'}}).composite([{input:mark,left:96,top:96}]).png().toFile(`${directory}/icon-maskable-512.png`);
await sharp(source).resize(180,180).flatten({background:'#141414'}).png().toFile(`${directory}/apple-touch-icon.png`);
