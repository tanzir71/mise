import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const require=createRequire(new URL('../packages/core/package.json',import.meta.url));
const source=readFileSync(require.resolve('libphonenumber-js/metadata.min.json'));
const metadata=JSON.parse(source),codes={};
// Metadata v4: numbering-plan possibleLengths is slot 3, as documented in source/metadata.js.
if(metadata.version!==4)throw new Error('Review the phone metadata format before regenerating.');
for(const [callingCode,countries] of Object.entries(metadata.country_calling_codes)){
  const lengths=[...new Set(countries.flatMap(country=>metadata.countries[country][3]))].sort((a,b)=>a-b);
  if(!lengths.length||lengths.some(length=>!Number.isInteger(length)||length<1||length>17))throw new Error('Unexpected phone lengths.');
  codes[callingCode]=lengths;
}
for(const [code,plan] of Object.entries(metadata.nonGeographic||{}))codes[code]=plan[3];
writeFileSync(new URL('../packages/core/public-phone-lengths.json',import.meta.url),JSON.stringify(codes)+'\n');
writeFileSync(new URL('../packages/core/public-phone-source.json',import.meta.url),JSON.stringify({package:'libphonenumber-js',version:require('libphonenumber-js/package.json').version,metadataVersion:metadata.version,sha256:createHash('sha256').update(source).digest('hex')},null,2)+'\n');
