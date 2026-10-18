import { z } from "zod";
import type { AccountClient } from "./account-client.js";
import { EncryptionError } from "./crypto-helper.js";
import { decodeObjectFrames, encodeObjectFrames, leaseBytes } from "./object-frames.js";

/** What the server's transfer endpoint offers beyond leases; an older server advertises neither. */
interface TransferFeatures { keepsEnvelope: boolean; binaryObjects: boolean }
export class TransferClient {
  private supported?:boolean;
  private features:TransferFeatures={keepsEnvelope:false,binaryObjects:false};
  constructor(readonly client:AccountClient,readonly path:string){}
  async available():Promise<boolean> {
    if(this.supported!==undefined)return this.supported;
    try {
      const value=await this.client.request<{transferLeases?:number;keepsEnvelope?:number;binaryObjects?:number}>(`${this.path}/capabilities`);
      this.features={keepsEnvelope:value.keepsEnvelope===1,binaryObjects:value.binaryObjects===1};
      return this.supported=value.transferLeases===1;
    }
    catch(error){if(error instanceof EncryptionError && error.state==="incompatible-format")return this.supported=false;throw error;}
  }
  /** Whether publish can leave out the envelope the lease already holds. Valid once available() has run. */
  get keepsEnvelope():boolean{return this.features.keepsEnvelope;}
  request<T>(data:object):Promise<T>{return this.client.request(`${this.path}/transfer`,"POST",data);}
  /** Uploads one batch of encrypted objects under a lease, as binary frames when the server takes them. */
  async upload(lease:string,objects:Array<readonly [string,Buffer]>):Promise<void> {
    if(this.features.binaryObjects)await this.client.requestBytes(`${this.path}/transfer-objects`,encodeObjectFrames(objects,leaseBytes(lease)));
    else await this.request({action:"upload",lease,objects:Object.fromEntries(objects.map(([address,bytes])=>[address,bytes.toString("base64")]))});
  }
  /** Reads one batch of encrypted objects under a lease, as binary frames when the server sends them. */
  async read(lease:string,addresses:string[]):Promise<Map<string,Buffer>> {
    if(this.features.binaryObjects){
      const body=await this.client.request<unknown>(`${this.path}/transfer-read`,"POST",{lease,addresses});
      if(!Buffer.isBuffer(body))throw new EncryptionError("verification-failed");
      return decodeObjectFrames(body);
    }
    const result=z.record(z.string(),z.string()).parse(await this.request({action:"read",lease,addresses}));
    return new Map(Object.entries(result).map(([address,bytes])=>[address,Buffer.from(bytes,"base64")]));
  }
  async using<T>(begin:object,work:(lease:string,result:Record<string,unknown>)=>Promise<T>):Promise<T> {
    const result=z.object({id:z.string().uuid(),expiresAt:z.number()}).passthrough().parse(await this.request(begin));
    let renewal:Promise<void>|undefined, failure:unknown;
    const timer=setInterval(()=>{if(!renewal)renewal=this.request({action:"renew",lease:result.id}).then(()=>{},e=>{failure=e;}).finally(()=>{renewal=undefined;});},300000);
    timer.unref();
    try {const value=await work(result.id,result);if(failure)throw failure;return value;}
    finally {clearInterval(timer);await renewal;await this.request({action:"release",lease:result.id}).catch(()=>{});}
  }
}
