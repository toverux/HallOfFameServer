/**
 * Sidecar worker for {@link ScreenshotSimilarityDetectorService}.
 * As most TensorFlow operations are blocking, inference was choking the event loop.
 *
 * This is written to run as a separate process because running in a Bun Web Worker didn't work,
 * as requiring N-API modules (TensorFlow) in a worker crashes right now.
 * However, conversion to a web worker will only require "minor" changes.
 *
 * The benefit of a worker is that it would allow zero-copy transfer of image data and embeddings,
 * as well as being leaner and more robust/clean to implement.
 * For the time being, while this is a separate process, keep the import list small, so the process'
 * runtime is as lean as possible.
 *
 * ! DO NOT import the file anywhere else (except types with `import type`).
 * ! DO NOT import other project files as well (keep the process lean).
 *
 * @see https://github.com/oven-sh/bun/issues/19339
 */

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
  readonly imagesData: ArrayBuffer[];
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
    | number[][];
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

assert(process.send, 'Worker process must be started with IPC');

// Load TensorFlow model.
const model = await tf.loadGraphModel(`file://${modelInfo.path}`);

// Start listening for requests.
process.on('message', handleRequest);

/**
 * Handles a {@link WorkerRequest} received through IPC, by processing image data into embeddings
 * and sending a response through IPC as well, using a {@link WorkerResponse} with the same ID as
 * the request.
 */
async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    const buffers = request.imagesData.map(buffer => new Uint8Array(buffer));

    const embeddings = inferEmbeddings(buffers).map(embedding => Array.from(embedding));

    return respond(embeddings);
  } catch (error) {
    return respond(error instanceof Error ? error : new Error(String(error)));
  }

  function respond(response: WorkerResponse['payload']): void {
    const message: WorkerResponse = {
      id: request.id,
      payload: response
    };

    // biome-ignore lint/style/noNonNullAssertion: cannot be null (assert preceding).
    process.send!(message);
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
    // worker/subprocess and make it all sync.
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
