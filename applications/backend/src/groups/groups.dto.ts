export class GroupDto {
  id!: string;
  name!: string;
}

export class GroupsResponseDto {
  groups!: GroupDto[];
}

export class GroupMemberDto {
  id!: string;
  display_name!: string;
}

export class GroupMembersResponseDto {
  members!: GroupMemberDto[];
}
