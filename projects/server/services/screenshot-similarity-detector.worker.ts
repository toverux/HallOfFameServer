/**
 * Sidecar worker for {@link ScreenshotSimilarityDetectorService}.
 * As most TensorFlow operations are blocking, the process was choking the event loop.
 *
 * Keep the import list small, so the worker's runtime is as lean as possible.
 *
 * ! DO NOT import the file anywhere else (except types with `import type`).
 * ! DO NOT import other project files as well (keep the process lean).
 */

declare const self: Worker;

import assert from 'node:assert/strict';
import path from 'node:path';
import * as tf from '@tensorflow/tfjs-node';

/**
 * Worker input message, must support the Structured Clone Algorithm.
 * The ID is a number to match a request with a response.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
 */
export type WorkerRequest = {
  readonly id: number;
  readonly imagesData: Uint8Array[];
};

/**
 * Worker output message, must support the Structured Clone Algorithm.
 * The ID is a number to match a request with a response.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
 */
export type WorkerResponse = {
  id: number;
  payload:
    | Error // Note: `Error` is serializable — non-standard subclasses are converted to `Error`.
    | Float32Array[];
};

/**
 * Configuration for a feature vector model.
 * Here we use EfficientNet V2 feature vector layer (not the classification layer).
 * Variant used is `imagenet21k-ft1k-m-feature-vector`.
 *
 * Converted for TFjs using:
 * ```sh
 * tensorflowjs_converter \
 *   --input_format=tf_hub \
 *   --signature_name=serving_default \
 *   https://www.kaggle.com/models/google/efficientnet-v2/TensorFlow2/imagenet21k-ft1k-m-feature-vector/2 \
 *   ./efficientnetv2
 * ```
 *
 * @see https://www.kaggle.com/models/google/efficientnet-v2/tensorFlow2/imagenet21k-ft1k-m-feature-vector
 */
const modelInfo = {
  path: path.join(import.meta.dir, '../../../efficientnetv2/model.json'),
  dimension: 1280,
  inputSize: [480, 480] satisfies [number, number]
};

// Load TensorFlow model.
const model = await tf.loadGraphModel(`file://${modelInfo.path}`);

// Start listening for requests.
self.addEventListener('message', event => handleRequest(event.data));

/**
 * Handles a {@link WorkerRequest} received through posted messages, by processing image data into
 * embeddings and posting those as a response, using a {@link WorkerResponse} with the same ID as
 * the request.
 */
function handleRequest(request: WorkerRequest): void {
  try {
    const embeddings = inferEmbeddings(request.imagesData);

    self.postMessage(
      {
        id: request.id,
        payload: embeddings
      } satisfies WorkerResponse,
      // Transfer ownership of underlying ArrayBuffers to the main thread.
      embeddings.map(embedding => embedding.buffer)
    );
  } catch (error) {
    self.postMessage({
      id: request.id,
      payload: error instanceof Error ? error : new Error(String(error))
    } satisfies WorkerResponse);
  }
}

/**
 * Infers embeddings from a list of image buffers using the TensorFlow model.
 * The method processes image buffers, extracts embeddings, and normalizes them.
 * ! This function MUST stay sync (see comments in the function), otherwise, implement a mutex.
 *
 * @param buffers Each buffer represents the raw data of an image to process.
 *
 * @return Array of normalized embedding vector for the respective input image, ready to be stored.
 */
function inferEmbeddings(buffers: readonly Uint8Array[]): Float32Array[] {
  // Start a new scope to ensure that the tensors are released when the scope is exited.
  tf.engine().startScope();

  try {
    // Convert buffers to tensors, shape [H, W, 3] for each tensor.
    const tensors = buffers.map(buffer =>
      tf.node
        // Decode the image from the buffer.
        .decodeImage(buffer, /* channels */ 3)
        // Resize to model input size.
        .resizeBilinear(modelInfo.inputSize)
        // Convert to floating point to not do integer division and because the model expects that.
        .toFloat()
        // Normalize pixels to the 0..1 range to better play with the model.
        .div(255)
    );

    // Batch them: shape [N, H, W, 3].
    const batchTensor = tf.concat(tensors.map(tensor => tensor.expandDims(0)));

    // Forward pass.
    const embeddingTensors = model.predict(batchTensor); // shape [N, D]

    assert(embeddingTensors instanceof tf.Tensor); // check it is not an array

    // Normalize embeddings.
    const norms = embeddingTensors.norm('euclidean', -1, true); // shape [N, 1]
    const normalizedEmbedding = embeddingTensors.div(norms).squeeze(); // shape [N, D]

    // Get final embeddings as an ArrayBuffer.
    // Note: there is also data() which returns a promise and is supposed to help run TF
    // asynchronously, however, in practice it didn't really help here, and that's the only place we
    // could use an async call. The other operations preceding are already quite intensive (ex.
    // image resizing) and synchronous. This is what justified moving the logic in a
    // worker and make it all sync.
    // Moreover, this has the benefit that this function MUST NOT be reentrant as there can only be
    // one active scope at a time, so with sync function we do not need to add a mutex.
    const flatEmbeddings = normalizedEmbedding.dataSync();

    // noinspection SuspiciousTypeOfGuard
    assert(flatEmbeddings instanceof Float32Array);

    const expectedLength = buffers.length * modelInfo.dimension;

    assert(
      flatEmbeddings.length == expectedLength,
      `Embeddings length mismatch, expected ${expectedLength}, got ${flatEmbeddings.length} instead`
    );

    // Create a view mapping each original buffer to its ArrayBuffer embedding.
    return buffers.map((_, i) =>
      flatEmbeddings.subarray(i * modelInfo.dimension, (i + 1) * modelInfo.dimension)
    );
  } finally {
    // Release TensorFlow memory for this scope.
    tf.engine().endScope();
  }
}
