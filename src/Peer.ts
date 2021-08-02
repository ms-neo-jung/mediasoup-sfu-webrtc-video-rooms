import {
  Worker,
  RtpParameters,
  Router,
  Transport,
  Producer,
  Consumer,
  DataProducer,
  DataConsumer,
  RtpCapabilities,
  MediaKind,
  DtlsParameters,
  ConsumerType,
} from "mediasoup/lib/types";

interface IConsumerInfo {
  consumer: Consumer;
  params: {
    producerId: string;
    id: string;
    kind: MediaKind;
    rtpParameters: RtpParameters;
    type: ConsumerType;
    producerPaused: boolean;
  };
}

class Peer {
  id: string;
  name: string;
  transports: Map<string, Transport>;
  consumers: Map<string, Consumer>;
  producers: Map<string, Producer>;

  constructor(socketId: string, name: string) {
    this.id = socketId;
    this.name = name;
    this.transports = new Map();
    this.consumers = new Map();
    this.producers = new Map();
  }

  addTransport(transport: Transport) {
    this.transports.set(transport.id, transport);
  }

  async connectTransport(transportId: string, dtlsParameters: DtlsParameters) {
    if (!this.transports.has(transportId)) {
      console.warn("transport not found ", transportId);
      return;
    }

    try {
      await this.transports.get(transportId).connect({
        dtlsParameters,
      });
    } catch (error) {
      console.error("connectTransport error ", error);
    }
  }

  async createProducer(
    producerTransportId: string,
    rtpParameters: RtpParameters,
    kind: MediaKind
  ): Promise<Producer> {
    //TODO handle null errors
    if (!this.transports.has(producerTransportId)) {
      console.warn(
        "Peer: createProducer: transport not found ",
        producerTransportId
      );
      throw `Peer: createProducer: transport not found ${producerTransportId}`;
    }

    try {
      let producer = await this.transports.get(producerTransportId).produce({
        kind,
        rtpParameters,
      });

      this.producers.set(producer.id, producer);

      producer.on("transportclose", () => {
        console.log(
          `---producer transport close--- name: ${this.name} consumer_id: ${producer.id}`
        );
        producer.close();
        this.producers.delete(producer.id);
      });

      return producer;
    } catch (error) {
      console.error("Peer: createProducer: error ", error);
      throw error;
    }
  }

  async createConsumer(
    consumerTransportId: string,
    producer_id: string,
    rtpCapabilities: RtpCapabilities
  ): Promise<IConsumerInfo> {
    if (!this.transports.has(consumerTransportId)) {
      console.warn(
        "Peer: createConsumer: transport not found ",
        consumerTransportId
      );
      throw `Peer: createConsumer: transport not found ${consumerTransportId}`;
    }

    let consumerTransport = this.transports.get(consumerTransportId);
    let consumer = null;

    try {
      consumer = await consumerTransport.consume({
        producerId: producer_id,
        rtpCapabilities,
        paused: false, //producer.kind === 'video',
      });
    } catch (error) {
      console.error("consume failed", error);
      throw error;
    }

    try {
      if (consumer.type === "simulcast") {
        await consumer.setPreferredLayers({
          spatialLayer: 2,
          temporalLayer: 2,
        });
      }
    } catch (error) {
      console.error("consume failed", error);
      throw error;
    }

    this.consumers.set(consumer.id, consumer);
    consumer.on("transportclose", () => {
      console.log(
        `---consumer transport close--- name: ${this.name} consumer_id: ${consumer.id}`
      );
      this.consumers.delete(consumer.id);
    });

    return {
      consumer,
      params: {
        producerId: producer_id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused,
      },
    };
  }

  closeProducer(producerId: string): void {
    if (!this.producers.has(producerId)) {
      console.warn("Peer: closeProducer producer not found ", producerId);
      return;
    }

    try {
      this.producers.get(producerId).close();
    } catch (e) {
      console.warn(e);
    }
    this.producers.delete(producerId);
  }

  getProducer(producerId: string): Producer | null {
    if (this.producers.has(producerId)) return this.producers.get(producerId);
    else return null;
  }

  close(): void {
    this.transports.forEach((transport) => transport.close());
  }

  removeConsumer(consumerId: string) {
    if (!this.consumers.has(consumerId)) {
      console.warn("Peer: removeConsumer comsumer not found ", consumerId);
      return;
    }

    this.consumers.delete(consumerId);
  }

  toJson() {
    return {
      id: this.id,
      name: this.name,
    };
  }
}

export default Peer;
