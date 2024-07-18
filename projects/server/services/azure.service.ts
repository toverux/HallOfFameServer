import { BlobServiceClient } from '@azure/storage-blob';
import { Injectable } from '@nestjs/common';
import { ConfigService } from './config.service';

@Injectable()
export class AzureService {
    public readonly blobServiceClient: BlobServiceClient;

    public constructor(config: ConfigService) {
        this.blobServiceClient = BlobServiceClient.fromConnectionString(
            config.azure.url
        );
    }
}
