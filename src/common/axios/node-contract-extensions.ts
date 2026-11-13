import { AddUserCommand, AddUsersCommand } from '@remnawave/node-contract';

// sing-box user types that the upstream Node contract does not define. Hysteria2 reuses the
// upstream `hysteria` user type because both carry a single password.
export type TAddUserToNodeRequest = Omit<AddUserCommand.Request, 'data'> & {
    data: Array<
        | AddUserCommand.Request['data'][number]
        | {
              type: 'anytls';
              tag: string;
              username: string;
              password: string;
          }
        | {
              type: 'tuic';
              tag: string;
              username: string;
              uuid: string;
              password: string;
          }
    >;
};

type TSingBoxBulkInbound = {
    type: 'anytls' | 'tuic';
    tag: string;
};

export type TAddUsersToNodeRequest = Omit<AddUsersCommand.Request, 'users'> & {
    users: Array<
        Omit<AddUsersCommand.Request['users'][number], 'inboundData'> & {
            inboundData: Array<
                | AddUsersCommand.Request['users'][number]['inboundData'][number]
                | TSingBoxBulkInbound
            >;
        }
    >;
};
