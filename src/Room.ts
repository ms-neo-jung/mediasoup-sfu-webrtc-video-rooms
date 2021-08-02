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
  RtpCodecCapability,
} from "mediasoup/lib/types";
import Peer from "./Peer";
import { Server, Socket } from "socket.io";

import config from "./config";
import { RouterOptions } from "../../../.cache/typescript/4.3/node_modules/@types/express";

class Room {
  id: string;
  peers: Map<string, Peer>;
  io: Server;
  worker: Worker;
  router: Router;

  constructor(roomId: string, worker: Worker, io: Server) {
    this.id = roomId;
    this.worker = worker;

    this.peers = new Map();
    this.io = io;
  }

  init = async () => {
    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    // @ts-ignore
    this.router = await this.worker.createRouter({ mediaCodecs });
  };

  addPeer(peer: Peer) {
    this.peers.set(peer.id, peer);
  }

  getProducerListForPeer(socketId: string): { producer_id: string }[] {
    let producerList: { producer_id: string }[] = [];
    this.peers.forEach((peer: Peer) => {
      peer.producers.forEach((producer) => {
        producerList.push({
          producer_id: producer.id,
        });
      });
    });
    return producerList;
  }

  getRtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  async createWebRtcTransport(socketId: string) {
    const { maxIncomingBitrate, initialAvailableOutgoingBitrate } =
      config.mediasoup.webRtcTransport;

    let transport = null;
    try {
      transport = await this.router.createWebRtcTransport({
        listenIps: config.mediasoup.webRtcTransport.listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate,
      });
    } catch (error) {
      console.error(
        "Room: createWebRtcTransport createWebRtcTransporterror ",
        error
      );
      throw error;
    }
    //
    if (maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(maxIncomingBitrate);
      } catch (error) {
        console.error(
          "Room: createWebRtcTransport setMaxIncomingBitrate error ",
          error
        );
      }
    }

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        console.log(
          "---transport close--- " + this.peers.get(socketId).name + " closed"
        );
        transport.close();
      }
    });

    transport.on("close", () => {
      console.log(
        "---transport close--- " + this.peers.get(socketId).name + " closed"
      );
    });
    console.log("---adding transport---", transport.id);
    if (!this.peers.has(socketId)) {
      console.warn("Room: createWebRtcTransport peer not found ", socketId);
      throw `Room: createWebRtcTransport peer not found ${socketId}`;
    }
    this.peers.get(socketId).addTransport(transport);
    return {
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  }

  async connectPeerTransport(
    socketId: string,
    transportId: string,
    dtlsParameters: DtlsParameters
  ) {
    if (!this.peers.has(socketId)) {
      console.warn("Room: connectPeerTransprt peer not found ", socketId);
      return;
    }

    try {
      await this.peers
        .get(socketId)
        .connectTransport(transportId, dtlsParameters);
    } catch (error) {
      console.error("Room: connectPeerTransport error ", error);
      throw error;
    }
  }

  async produce(
    socket_id: string,
    producerTransportId: string,
    rtpParameters: RtpParameters,
    kind: MediaKind
  ): Promise<string> {
    // handle undefined errors

    if (!this.peers.has(socket_id)) {
      console.warn("produce: peer not found ", socket_id);
      throw `peer not found ${socket_id}`;
    }

    const peer = this.peers.get(socket_id);
    try {
      const producer = await peer.createProducer(
        producerTransportId,
        rtpParameters,
        kind
      );
      this.broadCast(socket_id, "newProducers", [
        {
          producer_id: producer.id,
          producer_socket_id: socket_id,
        },
      ]);

      return producer.id;
    } catch (error) {
      console.error("room: produce error ", error);
      throw error;
    }

    // return new Promise(
    //   async function (resolve, reject) {
    //     let producer = await this.peers
    //       .get(socket_id)
    //       .createProducer(producerTransportId, rtpParameters, kind);
    //     resolve(producer.id);
    //     this.broadCast(socket_id, "newProducers", [
    //       {
    //         producer_id: producer.id,
    //         producer_socket_id: socket_id,
    //       },
    //     ]);
    //   }.bind(this)
    // );
  }

  async consume(
    socket_id: string,
    consumer_transport_id: string,
    producer_id: string,
    rtpCapabilities: RtpCapabilities
  ) {
    // handle nulls
    if (
      !this.router.canConsume({
        producerId: producer_id,
        rtpCapabilities,
      })
    ) {
      console.error("can not consume");
      return;
    }

    let { consumer, params } = await this.peers
      .get(socket_id)
      .createConsumer(consumer_transport_id, producer_id, rtpCapabilities);

    consumer.on("producerclose", () => {
      console.log(
        `---consumer closed--- due to producerclose event  name:${
          this.peers.get(socket_id).name
        } consumer_id: ${consumer.id}`
      );
      this.peers.get(socket_id).removeConsumer(consumer.id);
      // tell client consumer is dead
      this.io.to(socket_id).emit("consumerClosed", {
        consumer_id: consumer.id,
      });
    });

    return params;
  }

  async removePeer(socket_id: string) {
    if (!this.peers.has(socket_id)) {
      console.warn("Room: removePeer not found ", socket_id);
      return;
    }

    this.peers.get(socket_id).close();
    this.peers.delete(socket_id);
  }

  closeProducer(socket_id: string, producer_id: string) {
    if (!this.peers.has(socket_id)) {
      console.warn("Room: closeProducer not found ", socket_id, producer_id);
      return;
    }
    this.peers.get(socket_id).closeProducer(producer_id);
  }

  broadCast(socket_id: string, name: string, data: unknown) {
    for (let otherID of Array.from(this.peers.keys()).filter(
      (id) => id !== socket_id
    )) {
      this.send(otherID, name, data);
    }
  }

  send(socket_id: string, name: string, data: unknown) {
    this.io.to(socket_id).emit(name, data);
  }

  getPeers() {
    return this.peers;
  }

  toJson() {
    const peers = [];
    this.peers.forEach((peer) => {
      peers.push(peer.toJson());
    });
    return {
      id: this.id,
      peers,
    };
  }
}

export default Room;
