import { BlobServiceClient } from '@azure/storage-blob';
import { Injectable } from '@nestjs/common';
import { config } from '../config';

@Injectable()
export class AzureService {
    public readonly blobServiceClient: BlobServiceClient;

    public constructor() {
        this.blobServiceClient = BlobServiceClient.fromConnectionString(
            config.azure.url
        );
    }
}
