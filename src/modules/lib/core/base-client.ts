import WebSocket from "ws";
import { isJsonString } from "@/utils/verify";
import {
	ActionRequest,
	ActionResponse,
	EventData,
	FriendInfo,
	GroupInfo,
	OneBotVersionInfo,
	Sendable,
	toMessageRecepElem
} from "@/modules/lib";
import WsMessage from "@/utils/message";
import { getLogger, Logger } from "log4js";
import EventEmitter from "@/modules/lib/core/event-emitter";
import { ApiMap } from "@/modules/lib/types/map/api";
import { formatSendMessage } from "@/modules/lib/message";
import { getRandomString } from "@/utils/random";

type ApiParam<T extends ( param: any ) => any> = T extends () => any
	? undefined
	: T extends ( param: infer P ) => any
		? P
		: never;

export default class BaseClient extends EventEmitter {
	private static __instance: BaseClient;
	private wsApi!: WsMessage;
	private wsEvent!: WsMessage;
	public gl: Map<number, GroupInfo> = new Map();
	public fl: Map<number, FriendInfo> = new Map();
	
	public uin: number = 0;
	public online: boolean = false;
	public oneBotVersion: OneBotVersionInfo | null = null;
	public logger: Logger = getLogger( "[adachi]" );
	
	constructor(
		private eventTarget: string,
		private apiTarget: string,
		private fetchTimeout: number
	) {
		super();
		if ( this.needApiConnect ) {
			this.wsEvent = new WsMessage( this.initEventWs.bind( this ), false );
			this.wsApi = new WsMessage( this.initApiWs.bind( this ), false );
		} else {
			this.wsEvent = this.wsApi = new WsMessage( ws => {
				this.initEventWs.call( this, ws );
				this.initApiWs.call( this, ws );
			}, false );
		}
	}
	
	public static getInstance( eventTarget?: string, apiTarget?: string, fetchTimeout?: number ) {
		if ( !BaseClient.__instance ) {
			if ( !eventTarget || typeof apiTarget === "undefined" || !fetchTimeout ) {
				throw new Error( "Invalid parameter" );
			}
			BaseClient.__instance = new BaseClient( eventTarget, apiTarget, fetchTimeout );
		}
		return BaseClient.__instance;
	}
	
	/* 设置请求协议端的超时时间 */
	public setFetchTimeout( fetchTimeout: number ) {
		this.fetchTimeout = fetchTimeout;
	}
	
	public setTarget( eventTarget: string, apiTarget: string ) {
		this.eventTarget = eventTarget;
		this.apiTarget = apiTarget;
	}
	
	private initApiWs( this: BaseClient, ws: WebSocket ) {
		ws.on( "open", () => {
			this.logger.info( `已连接到 api 事件服务器：${ this.apiTarget || this.eventTarget }` );
		} );
		ws.on( "message", ( res ) => {
			const resp = ( <Buffer>res ).toString();
			let data: ActionResponse;
			if ( !isJsonString( resp ) ) {
				return;
			}
			data = JSON.parse( resp );
			// 此时为 webhook 回执，过
			if ( !data.echo ) {
				return;
			}
			if ( data.retcode === 1 ) {
				return;
			}
			this.emitApi( data.echo, data );
		} );
	}
	
	private getVersionInfo() {
		this.fetchApi( "get_version_info", undefined ).then( data => {
			this.oneBotVersion = data.retcode === 0
				? data.data
				: null
		} ).catch( () => {} );
	}
	
	public setGroupList() {
		this.fetchApi( "get_group_list", undefined ).then( data => {
			this.gl = data.retcode === 0
				? new Map( data.data.map( d => [ d.group_id, d ] ) )
				: new Map();
		} ).catch( () => {} );
	}
	
	public setFriendList() {
		this.fetchApi( "get_friend_list", undefined ).then( data => {
			this.fl = data.retcode === 0
				? new Map( data.data.map( d => [ d.user_id, d ] ) )
				: new Map();
		} ).catch( () => {} );
	}
	
	private initEventWs( this: BaseClient, ws: WebSocket ) {
		ws.on( "open", () => {
			this.logger.info( `已连接到 event 事件服务器：${ this.eventTarget }` );
		} );
		ws.on( "message", ( res ) => {
			const resp = ( <Buffer>res ).toString();
			let data: EventData;
			if ( !isJsonString( resp ) ) {
				return;
			}
			data = JSON.parse( resp );
			// 此时为 api 回执，过
			if ( Reflect.has( data, "echo" ) ) {
				return;
			}
			
			const quickOperation = ( params: Record<string, any> ) => {
				return this.fetchApi( <any>".handle_quick_operation", {
					context: data,
					operation: params
				} );
			};
			
			if ( data.post_type === "meta_event" ) {
				if ( data.meta_event_type === "lifecycle" ) {
					this.emit( "system.lifecycle", data );
				}
				if ( data.meta_event_type === "heartbeat" ) {
					if ( data.status.online !== this.online ) {
						this.online = data.status.online;
						if ( this.online ) {
							/* 初始化版本信息 */
							this.getVersionInfo();
							/* 初始化群组列表 */
							this.setGroupList();
							/* 初始化好友列表 */
							this.setFriendList();
							this.emit( "system.online", data );
						} else {
							this.emit( "system.offline", data );
						}
					}
				}
				this.emit( "system", data );
			}
			
			if ( data.post_type === "message" ) {
				/* 若消息格式为 string，手动格式化为 json */
				const message: any = data.message;
				if ( typeof message === "string" ) {
					data.message = toMessageRecepElem( message );
				}
				/* 是否为 at bot */
				const atMeEl = data.message.find( el => {
					return el.type === "at" && Number.parseInt( el.data.qq ) === this.uin;
				} )
				data.atMe = !!atMeEl;
				
				if ( data.sub_type === "friend" || data.sub_type === "group" ) {
					data.reply = ( content: Sendable ) => quickOperation( { reply: formatSendMessage( content ) } );
					switch ( data.sub_type ) {
						case "friend":
							this.logger.info( `来自好友 ${ data.sender.nickname }(${ data.sender.user_id }) 的私聊消息: ${ data.raw_message }` );
							this.emit( "message.private.friend", data );
							break;
						case "group":
							const groupInfo = this.gl.get( data.sender.group_id );
							const groupName = groupInfo ? groupInfo.group_name : "";
							this.logger.info( `来自群 ${ groupName }(${ data.sender.group_id }) 内 ${ data.sender.nickname }(${ data.sender.user_id }) 的临时会话消息: ${ data.raw_message }` );
							this.emit( "message.private.group", data );
							break;
					}
					this.emit( "message.private", data );
				}
				if ( data.sub_type === "normal" || data.sub_type === "anonymous" ) {
					const groupInfo = this.gl.get( data.group_id );
					const groupName = groupInfo ? groupInfo.group_name : "";
					data.reply = ( content: Sendable, at = true ) => quickOperation( {
						reply: formatSendMessage( content ),
						at_sender: at
					} );
					data.recall = () => quickOperation( { delete: true } );
					data.kick = () => quickOperation( { kick: true } );
					data.ban = ( duration ) => quickOperation( { ban: true, ban_duration: duration } );
					switch ( data.sub_type ) {
						case "normal":
							this.logger.info( `来自群 ${ groupName }(${ data.group_id }) 内 ${ data.sender.card || data.sender.nickname }(${ data.sender.user_id }) 的消息: ${ data.raw_message }` );
							this.emit( "message.group.normal", data );
							break;
						case "anonymous":
							this.logger.info( `来自群 ${ groupName }(${ data.group_id }) 内 ${ data.anonymous.name } 的匿名消息: ${ data.raw_message }` );
							this.emit( "message.group.anonymous", data );
					}
					this.emit( "message.group", data );
				}
				this.emit( "message", data );
			}
			
			if ( data.post_type === "notice" ) {
				if ( this.checkNoticePrivateEvent( data ) ) {
					switch ( data.notice_type ) {
						case "friend_add":
							this.setFriendList();
							this.logger.info( `更新好友列表：新增好友 ${ data.user_id }` );
							this.emit( "notice.friend.add", data );
							break;
						case "friend_recall":
							this.emit( "notice.friend.recall", data );
							break;
					}
				} else {
					switch ( data.notice_type ) {
						case "group_recall":
							this.emit( "notice.group.recall", data );
							break;
						case "group_increase":
							this.emit( "notice.group.increase", data );
							if ( data.user_id === this.uin ) {
								this.setGroupList();
								this.logger.info( `更新群列表：新增群聊 ${ data.group_id }` );
								this.emit( "notice.group.increase", data );
							} else {
								this.emit( "notice.group.member_increase", data );
							}
							break;
						case "group_decrease":
							if ( data.sub_type === "kick_me" || data.user_id === this.uin ) {
								this.setGroupList();
								this.logger.info( `更新群列表：移除群聊 ${ data.group_id }` );
								this.emit( "notice.group.decrease", data );
							} else {
								this.emit( "notice.group.member_decrease", data );
							}
							break;
						case "group_admin":
							this.emit( "notice.group.admin", data );
							break;
						case "group_upload":
							this.logger.info( `来自群 ${ data.group_id } 内 ${ data.user_id } 上传的文件: ${ data.file.name }` );
							this.emit( "notice.group.upload", data );
							break;
						case "group_ban":
							this.emit( "notice.group.ban", data );
							break;
						case "notify":
							if ( data.sub_type === "lucky_king" ) {
								this.emit( "notice.group.lucky_king", data );
							}
							if ( data.sub_type === "honor" ) {
								this.emit( "notice.group.honor", data );
							}
							if ( ( <any>data ).sub_type === "poke" ) {
								this.emit( "notice.group.poke", <any>data );
							}
							break;
					}
					this.emit( "notice.group", data );
				}
				this.emit( "notice", data );
			}
			
			if ( data.post_type === "request" ) {
				switch ( data.request_type ) {
					case "friend":
						data.approve = ( approve, remark ) => quickOperation( { approve, remark } );
						this.logger.info( `来自 (${ data.user_id }) 的添加好友请求` );
						this.emit( "request.friend", data );
						break;
					case "group":
						data.approve = ( approve, reason ) => quickOperation( { approve, reason } );
						this.logger.info( `来自群 ${ data.group_id } 内 (${ data.user_id }) 的入群请求` );
						this.emit( "request.group", data );
						break;
				}
				this.emit( "request", data );
			}
			// 不执行心跳
			if ( data.post_type === "meta_event" ) {
				return;
			}
		} );
		ws.on( "close", () => {
			if ( this.online ) {
				this.online = false;
				this.emit( "system.offline", null );
			}
		} )
	}
	
	/** 请求 api */
	public fetchApi<T extends keyof ApiMap>( action: T, params: ApiParam<ApiMap[T]> ): Promise<ActionResponse<ReturnType<ApiMap[T]>>> {
		const echo = Date.now().toString( 36 ) + getRandomString( 6 );
		if ( !this.online ) {
			return Promise.resolve( <ActionResponse>{
				retcode: 401,
				status: "failed",
				data: null,
				msg: "Not_Login",
				wording: "未登录",
				echo
			} );
		}
		
		this.printSendLogger( action, params );
		this.sendMessage( { action, params: params || {}, echo } );
		/* 10000ms 超时 */
		const timer = setTimeout( () => {
			this.emitApi( echo, {
				retcode: 408,
				status: "failed",
				data: null,
				msg: `Action ${ action } Request_Timeout`,
				wording: `Api ${ action } 请求超时`,
				echo
			} )
		}, this.fetchTimeout );
		return new Promise( resolve => {
			this.onApi( echo, data => {
				clearTimeout( timer );
				resolve( data );
			} );
		} )
	}
	
	// 是否需要为 api 创建第二个 websocket 链接
	private get needApiConnect() {
		return this.apiTarget && this.apiTarget !== this.eventTarget;
	}
	
	/* 根据 message 类型获取日志打印内容 */
	private getMessageLogger( message: any ) {
		if ( typeof message === "string" ) {
			return message;
		}
		if ( message instanceof Array ) {
			return message.map( msg => {
				return this.getMessageLogger( msg );
			} ).join( "" );
		}
		
		const { type, data } = message;
		if ( type === "text" ) {
			return data.text;
		}
		const msgMap = {
			at: data.qq,
			music: data.id || data.url,
			reply: data.id || data.qq,
			face: data.id,
			share: data.url,
			poke: data.qq,
			gift: data.id,
			image: "[图片]",
			record: "[语音]",
			video: "[视频]"
		}
		const tipMsg = msgMap[type] || "";
		if ( tipMsg ) {
			return `{${ type }: ${ tipMsg }}`;
		}
		return `{${ type }}`;
	}
	
	/* 打印消息发送日志 */
	private printSendLogger( action: string, params: any = {} ) {
		let tipTarget = "";
		if ( action === "send_msg" ) {
			tipTarget = params.message_type === "group" ? `[群聊(${ params.group_id })]` : `[私聊(${ params.user_id })]`;
		}
		if ( action === "send_private_msg" ) {
			tipTarget = `[私聊(${ params.user_id })]`;
		}
		if ( action === "send_group_msg" ) {
			tipTarget = `[群聊(${ params.group_id })]`;
		}
		if ( !tipTarget ) {
			return;
		}
		const tipMessage = this.getMessageLogger( params.message );
		this.logger.info( `消息发送成功: ${ tipTarget } ${ tipMessage }` );
	}
	
	public sendMessage( data: ActionRequest ) {
		this.wsApi.sendMessage( data );
	}
	
	public connect(): Promise<void> {
		this.wsEvent.connect( `ws://${ this.eventTarget }` );
		if ( this.needApiConnect ) {
			this.wsApi.connect( `ws://${ this.apiTarget }` );
		}
		/* 监听连接成功状态 */
		return new Promise( resolve => {
			let timer: any = setInterval( () => {
				if ( this.wsApi.isOpen() && this.wsEvent.isOpen() ) {
					clearInterval( timer );
					timer = null;
					resolve();
				}
			}, 500 )
		} );
	}
	
	public closeConnect() {
		this.wsEvent.closeConnect();
		if ( this.needApiConnect ) {
			this.wsApi.closeConnect();
		}
	}
	
	public reConnect() {
		this.closeConnect();
		this.connect();
	}
}