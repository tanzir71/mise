/*!
 * LZ-String-compatible decoder, adapted from lz-string 1.5.0.
 * MIT License — Copyright (c) 2013 pieroxy
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** Read the Uint8Array wire format, stopping before an oversized result grows. */
export function decompressLzBounded(bytes:Uint8Array,maxCharacters:number):string{
  if(!bytes.length||bytes.length%2||!Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>65536)throw new Error('Invalid compressed shop link.');
  let offset=0;
  function read(count:number){
    let value=0;
    for(let i=0;i<count;i++){
      if(offset>=bytes.length*8)throw new Error('The compressed shop link is incomplete.');
      value|=((bytes[offset>>3]>>(7-(offset&7)))&1)<<i;offset++;
    }return value;
  }
  const first=read(2);
  if(first===2)return '';
  if(first>1)throw new Error('Invalid compressed shop link.');
  const initial=String.fromCharCode(read(first===0?8:16)),dictionary:string[]=['','','',initial],parts=[initial];
  let previous=initial,size=4,width=3,remaining=4,length=1;
  while(true){
    let code=read(width);
    if(code===0||code===1){dictionary[size++]=String.fromCharCode(read(code===0?8:16));code=size-1;remaining--;}
    else if(code===2)return parts.join('');
    if(remaining===0){remaining=2**width;width++;}
    const entry=dictionary[code]||(code===size?previous+previous[0]:null);
    if(entry===null)throw new Error('Invalid compressed shop link.');
    length+=entry.length;if(length>maxCharacters)throw new Error('The expanded shop link is too large.');
    parts.push(entry);dictionary[size++]=previous+entry[0];remaining--;previous=entry;
    if(remaining===0){remaining=2**width;width++;}
  }
}
